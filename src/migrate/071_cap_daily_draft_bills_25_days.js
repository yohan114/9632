'use strict';

/**
 * Migration 071: Recalculate existing DRAFT DAILY bills exceeding 25 days to the 25-day working month base.
 *
 * Only modifies `status = 'DRAFT'` bills where `UPPER(rate_basis) = 'DAILY'` and `billable_units > 25`.
 * Final/Issued/Paid/Void bills are untouched.
 */

const calc = require('../lib/billing/calc');

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function runMigration(targetDb) {
  if (!targetDb || !tableExists(targetDb, 'fleet_bills')) {
    return { skipped: true };
  }

  let draftBillsRecalculated = 0;

  targetDb.transaction(() => {
    const drafts = targetDb.prepare(`
      SELECT *
        FROM fleet_bills
       WHERE status = 'DRAFT'
         AND UPPER(COALESCE(rate_basis, '')) = 'DAILY'
         AND billable_units > 25
    `).all();

    if (!drafts.length) return;

    const hasLineItems = tableExists(targetDb, 'fleet_bill_line_items');
    const updBill = targetDb.prepare(`
      UPDATE fleet_bills
         SET actual_units = ?,
             minimum_units = ?,
             billable_units = ?,
             rental_amount_cents = ?,
             breakdown_deduct_cents = ?,
             subtotal_cents = ?,
             sscl_cents = ?,
             vat_cents = ?,
             grand_total_cents = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `);

    const updLine = hasLineItems
      ? targetDb.prepare(`
          UPDATE fleet_bill_line_items
             SET quantity = ?,
                 amount_cents = ?,
                 description = ?
           WHERE id = ?
        `)
      : null;

    const getLine = hasLineItems
      ? targetDb.prepare("SELECT id, description FROM fleet_bill_line_items WHERE bill_id = ? AND item_type = 'RENTAL'")
      : null;

    for (const b of drafts) {
      const rateCents = Number(b.rate_cents) || 0;
      const bdDays = Math.max(0, Number(b.breakdown_days) || 0);
      const ssclRate = b.sscl_rate != null ? Number(b.sscl_rate) : 0.025;
      const vatRate = b.vat_rate != null ? Number(b.vat_rate) : 0.18;
      const fuelLitres = Number(b.fuel_litres) || 0;
      const existingFuelCents = Number(b.fuel_cost_cents) || 0;
      const fuelPriceCents = (fuelLitres > 0 && existingFuelCents > 0)
        ? Math.round(existingFuelCents / fuelLitres)
        : 0;

      const res = calc.calculateRentalBill({
        actualUnits: 25,
        minimumUnits: 25,
        rateBasis: 'DAILY',
        billingMode: b.billing_mode,
        rateCents,
        breakdownDays: bdDays,
        workingDaysInMonth: 25,
        daysInMonth: 25,
        fuelLitres,
        fuelPriceCents,
        ssclRate,
        vatRate,
      });

      const netRentalCents = Math.max(0, res.rentalAmountCents - res.breakdownDeductCents);
      const subtotalCents = Math.max(0, netRentalCents + existingFuelCents);
      const ssclCents = Math.round(subtotalCents * ssclRate);
      const preVatCents = subtotalCents + ssclCents;
      const vatCents = Math.round(preVatCents * vatRate);
      const grandTotalCents = preVatCents + vatCents;

      const info = updBill.run(
        25,
        25,
        25,
        res.rentalAmountCents,
        res.breakdownDeductCents,
        subtotalCents,
        ssclCents,
        vatCents,
        grandTotalCents,
        b.id
      );
      if (info.changes > 0) draftBillsRecalculated++;

      if (updLine && getLine) {
        const lines = getLine.all(b.id);
        for (const li of lines) {
          const nextDesc = String(li.description || '')
            .replace(/\(\s*(26|27|28|29|30|31)(?:\.0+)?\s+daily\b/gi, '(25 daily');
          updLine.run(25, res.rentalAmountCents, nextDesc, li.id);
        }
      }
    }
  })();

  return { draftBillsRecalculated };
}

module.exports = { runMigration };
