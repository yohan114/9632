'use strict';

// Phase A — Category → Sub-category tree (item_categories) + backfill.
//
// Two jobs, both idempotent:
//
//   1. SEED the tree. 19 canonical parents (the vocabulary store_items already uses,
//      each keeping the 3-letter item_no prefix it already owns) with a starter set of
//      workshop-real sub-categories under each. The owner edits these live afterwards
//      (rename / add / merge / deactivate) — nothing here is meant to be final.
//
//   2. BACKFILL category_id on store_items / mrn_lines / issues / mtn, and fold the
//      OLD 9-value vocabulary used by requests+issues+transfers ('Belts', 'Tyre',
//      'Oil & Lubricants'…) into the canonical 19, so the two drifting lists become
//      one. The free-text `category` column is rewritten to the canonical PARENT name
//      (every existing report groups by that text) while category_id points at the
//      leaf sub-category.
//
// Sub-category placement is a conservative keyword match on the item name /line
// description: the FIRST matching rule wins, and anything that matches nothing lands
// in that parent's "General" bucket. It is a starting point, not a claim of accuracy —
// every row can be moved later from the Categories tab.
//
// Only rows with category_id IS NULL are touched, so re-running is a no-op.
//
// Run:  node src/migrate/run.js --step subcategories

const { get, all, run, tx } = require('../db');
// The tree helpers own the canonical vocabulary; the migration seeds what they expect.
const { norm, ALIASES } = require('../lib/categories');

// Canonical tree. `code` = the item_no prefix these items already carry.
// Sub order matters: the first `match` that hits wins, so the specific rules come
// before the broad ones. 'General' (no match) is always last = the fallback bucket.
const TREE = [
  { name: 'General Items', code: 'GEN', subs: [
    { name: 'Fasteners', match: /\b(bolt|nut|washer|screw|rivet|stud|circlip)\b/i },
    { name: 'Sealants & Adhesives', match: /sealant|silicone|adhesive|glue|gasket maker|araldite/i },
    { name: 'Paints & Thinners', match: /paint|thinner|primer/i },
    { name: 'Electrodes & Welding', match: /electrode|welding/i },
    { name: 'Cleaning & Chemicals', match: /clean|degrease|kerosene|soap|detergent|wd.?40|spray/i },
    { name: 'Tapes & Sundries', match: /tape|rope|string|brush/i },
    { name: 'General' },
  ] },
  { name: 'Filters', code: 'FIL', subs: [
    { name: 'Hydraulic Filter', match: /hydraulic|\bhyd\b/i },
    { name: 'Transmission Filter', match: /transmission|\btrans\b|gear ?box/i },
    { name: 'Fuel & Diesel Filter', match: /diesel|fuel|water separator/i },
    { name: 'Air Filter', match: /\bair\b/i },
    { name: 'Cabin & Other Filter', match: /cabin|pollen|a\/?c\b/i },
    { name: 'Oil Filter', match: /\boil\b|lube/i },
    { name: 'General' },
  ] },
  { name: 'Electrical', code: 'ELE', subs: [
    { name: 'Lights & Lamps', match: /light|lamp|bulb|beacon|indicator|reflector/i },
    { name: 'Starter & Alternator', match: /starter|alternator|dynamo|armature|solenoid|\bself\b/i },
    { name: 'Fuses & Relays', match: /fuse|relay|flasher/i },
    { name: 'Sensors & Gauges', match: /sensor|sender|gauge|\bmeter\b|thermostat switch/i },
    { name: 'Wiring & Switches', match: /wire|wiring|cable|switch|socket|plug|connector|harness/i },
    { name: 'Batteries & Terminals', match: /battery|terminal/i },
    { name: 'General' },
  ] },
  { name: 'Engine Parts', code: 'ENG', subs: [
    { name: 'Injection & Fuel System', match: /injector|injection|nozzle|fuel pump|feed pump|delivery valve/i },
    { name: 'Cooling System', match: /radiator|water pump|thermostat|coolant|fan\b/i },
    { name: 'Turbo & Air Intake', match: /turbo|manifold|intercooler|air cleaner/i },
    { name: 'Pistons & Liners', match: /piston|liner|\bring\b|crank|con.?rod|bearing shell/i },
    { name: 'Valvetrain & Head', match: /valve|\bhead\b|rocker|camshaft|tappet|push ?rod/i },
    { name: 'Gaskets & Seals', match: /gasket|seal|o.?ring/i },
    { name: 'General' },
  ] },
  { name: 'Transmission & Drivetrain', code: 'TRN', subs: [
    { name: 'Clutch', match: /clutch|pressure plate|release bearing/i },
    { name: 'Propeller Shaft & U-Joint', match: /propeller|prop ?shaft|universal|u.?joint|spider/i },
    { name: 'Differential & Axle', match: /\bdiff|axle|crown|pinion|\bhub\b/i },
    { name: 'Gearbox', match: /gear ?box|\bgear\b|synchro|shift|selector/i },
    { name: 'General' },
  ] },
  { name: 'Brakes & Clutch', code: 'BRK', subs: [
    { name: 'Brake Pads & Shoes', match: /\bpad\b|\bshoe\b|lining/i },
    { name: 'Brake Discs & Drums', match: /disc|drum|rotor/i },
    { name: 'Brake Hydraulics', match: /master cylinder|wheel cylinder|brake (hose|pipe|fluid)|caliper|air chamber/i },
    { name: 'Clutch', match: /clutch|pressure plate|release bearing/i },
    { name: 'General' },
  ] },
  { name: 'Suspension & Steering', code: 'SUS', subs: [
    { name: 'Springs & Shock Absorbers', match: /spring|shock|damper|absorber|\bleaf\b/i },
    { name: 'Ball Joints & Tie Rods', match: /ball joint|tie rod|track rod|king ?pin/i },
    { name: 'Steering Linkage', match: /steering|drag link|pitman|idler/i },
    { name: 'Bushes & Mountings', match: /bush|mount|rubber/i },
    { name: 'General' },
  ] },
  { name: 'Hydraulics', code: 'HYD', subs: [
    { name: 'Cylinders & Seal Kits', match: /cylinder|seal ?kit|\bram\b|boom|bucket/i },
    { name: 'Hoses & Fittings', match: /hose|fitting|coupling|nipple|adapter|elbow/i },
    { name: 'Pumps & Motors', match: /pump|motor/i },
    { name: 'Valves', match: /valve|solenoid/i },
    { name: 'General' },
  ] },
  { name: 'Bearings & Seals', code: 'BRG', subs: [
    { name: 'Bearings', match: /bearing/i },
    { name: 'O-Rings & Gaskets', match: /o.?ring|gasket/i },
    { name: 'Oil Seals', match: /seal/i },
    { name: 'General' },
  ] },
  { name: 'Belts & Hoses', code: 'BLT', subs: [
    { name: 'Timing Belts', match: /timing/i },
    { name: 'Radiator & Water Hoses', match: /radiator|water hose|coolant hose/i },
    { name: 'Air Hoses', match: /air (hose|pipe)/i },
    { name: 'V-Belts', match: /\bbelt\b|v.?belt|fan belt/i },
    { name: 'General' },
  ] },
  { name: 'Body & Cabin', code: 'BDY', subs: [
    { name: 'Glass & Mirrors', match: /glass|mirror|windscreen|window/i },
    { name: 'Wipers', match: /wiper/i },
    { name: 'Seats & Interior', match: /seat|cushion|interior|dashboard|floor ?mat/i },
    { name: 'Doors & Panels', match: /door|panel|fender|bonnet|guard|body/i },
    { name: 'General' },
  ] },
  { name: 'Tyres & Wheels', code: 'TYR', subs: [
    { name: 'Tubes & Flaps', match: /tube|flap/i },
    { name: 'Tyres', match: /tyre|tire/i },
    { name: 'Rims & Wheels', match: /\brim\b|wheel/i },
    { name: 'Valves & Weights', match: /valve|weight/i },
    { name: 'General' },
  ] },
  { name: 'Battery', code: 'BAT', subs: [
    { name: 'Terminals & Cables', match: /terminal|cable|clamp/i },
    { name: 'Battery Water & Acid', match: /water|acid|distilled/i },
    { name: 'Batteries', match: /batter/i },
    { name: 'General' },
  ] },
  { name: 'Lubricants & Fluids', code: 'LUB', subs: [
    { name: 'Grease', match: /grease/i },
    { name: 'Coolant & Brake Fluid', match: /coolant|brake fluid|dot ?[34]|antifreeze/i },
    { name: 'Hydraulic Oil', match: /hydraulic|hd ?(46|68)/i },
    { name: 'Gear Oil', match: /gear|80w|\b90\b|\b140\b/i },
    { name: 'Engine Oil', match: /engine oil|c[fi] ?4|15w|20w ?50|sae ?40/i },
    { name: 'General' },
  ] },
  { name: 'Hardware & Fasteners', code: 'HDW', subs: [
    { name: 'Bolts & Nuts', match: /bolt|\bnut\b|screw|stud/i },
    { name: 'Washers & Circlips', match: /washer|circlip|\bclip\b|snap ?ring/i },
    { name: 'Pins & Keys', match: /\bpin\b|\bkey\b|cotter/i },
    { name: 'Chains & Cables', match: /chain|cable|wire rope|sling/i },
    { name: 'General' },
  ] },
  { name: 'Consumables', code: 'CON', subs: [
    { name: 'Paints & Thinners', match: /paint|primer|enamel|thinner/i },
    { name: 'Welding Consumables', match: /electrode|welding/i },
    { name: 'Abrasives', match: /grinding|cutting (disc|wheel)|emery|sand ?paper|abrasive/i },
    { name: 'Tapes & Adhesives', match: /tape|glue|adhesive|sealant|silicone/i },
    { name: 'Cleaning & Chemicals', match: /clean|degrease|kerosene|soap|detergent|wd.?40|spray/i },
    { name: 'General' },
  ] },
  { name: 'Tools', code: 'TOL', subs: [
    { name: 'Measuring Tools', match: /gauge|\bmeter\b|caliper|micrometer|tape measure/i },
    { name: 'Power Tools', match: /grinder|drill|cutter|compressor|welding plant|machine/i },
    { name: 'Workshop Equipment', match: /jack|stand|trolley|hoist|puller|press/i },
    { name: 'Hand Tools', match: /spanner|wrench|plier|screw ?driver|hammer|chisel|\bfile\b|socket/i },
    { name: 'General' },
  ] },
  { name: 'Welding & Gas', code: 'WLD', subs: [
    { name: 'Electrodes', match: /electrode|\brod\b/i },
    { name: 'Gas & Cylinders', match: /\bgas\b|oxygen|acetylene|cylinder|lpg/i },
    { name: 'Welding Accessories', match: /torch|nozzle|\btip\b|holder|mask|regulator|hose/i },
    { name: 'General' },
  ] },
  { name: 'Other', code: 'OTH', subs: [{ name: 'General' }] },
];

// Rows whose category is blank or unrecognised land here.
const FALLBACK_PARENT = 'Other';

function runStep() {
  const rep = {
    parents_created: 0, parents_existing: 0, subs_created: 0, subs_existing: 0,
    backfilled: {}, auto_placed: 0, defaulted: 0, labels_normalised: 0, unknown_categories: [],
  };

  // -- 1. seed the tree -------------------------------------------------------
  const parents = new Map();   // name_norm -> { id, name, subs: [{id, match}], generalId }
  tx(() => {
    TREE.forEach((p, pi) => {
      const pn = norm(p.name);
      let row = get('SELECT id FROM item_categories WHERE parent_id IS NULL AND name_norm = ?', pn);
      if (row) rep.parents_existing++;
      else {
        row = { id: run('INSERT INTO item_categories (parent_id, name, name_norm, code, sort_order) VALUES (NULL, ?, ?, ?, ?)',
          p.name, pn, p.code, pi).lastInsertRowid };
        rep.parents_created++;
      }
      const entry = { id: row.id, name: p.name, subs: [], generalId: null };
      p.subs.forEach((s, si) => {
        const sn = norm(s.name);
        let sub = get('SELECT id FROM item_categories WHERE parent_id = ? AND name_norm = ?', row.id, sn);
        if (sub) rep.subs_existing++;
        else {
          sub = { id: run('INSERT INTO item_categories (parent_id, name, name_norm, sort_order) VALUES (?, ?, ?, ?)',
            row.id, s.name, sn, si).lastInsertRowid };
          rep.subs_created++;
        }
        if (s.match) entry.subs.push({ id: sub.id, match: s.match });
        else entry.generalId = sub.id;
      });
      // A parent whose seed list has no explicit fallback still needs one.
      if (!entry.generalId) entry.generalId = entry.subs.length ? entry.subs[0].id : null;
      parents.set(pn, entry);
    });
  });

  // Alias lookup: legacy label -> canonical parent entry.
  const resolveParent = (label) => {
    const n = norm(label);
    if (!n) return parents.get(norm(FALLBACK_PARENT));
    if (parents.has(n)) return parents.get(n);
    const aliased = ALIASES[n];
    if (aliased && parents.has(norm(aliased))) return parents.get(norm(aliased));
    if (!rep.unknown_categories.includes(label)) rep.unknown_categories.push(label);
    return parents.get(norm(FALLBACK_PARENT));
  };

  // First matching rule wins; no match -> the parent's General bucket.
  const classify = (parent, text) => {
    const t = String(text == null ? '' : text);
    for (const s of parent.subs) {
      if (s.match.test(t)) { rep.auto_placed++; return s.id; }
    }
    rep.defaulted++;
    return parent.generalId;
  };

  // -- 2. backfill ------------------------------------------------------------
  const backfill = (table, textCol) => {
    const rows = all(`SELECT id, ${textCol} AS txt, category FROM ${table} WHERE category_id IS NULL`);
    let n = 0;
    tx(() => {
      for (const r of rows) {
        const parent = resolveParent(r.category);
        if (!parent) continue;
        const subId = classify(parent, r.txt);
        // Rewrite the free-text label to the canonical parent name so the two old
        // vocabularies collapse into one (reports group by this column).
        if (norm(r.category) !== norm(parent.name)) rep.labels_normalised++;
        run(`UPDATE ${table} SET category_id = ?, category = ? WHERE id = ?`, subId, parent.name, r.id);
        n++;
      }
    });
    rep.backfilled[table] = n;
  };

  backfill('store_items', 'name');
  backfill('mrn_lines', 'description');
  backfill('issues', 'description');
  backfill('mtn', 'description');

  rep.total_parents = get('SELECT COUNT(*) c FROM item_categories WHERE parent_id IS NULL').c;
  rep.total_subs = get('SELECT COUNT(*) c FROM item_categories WHERE parent_id IS NOT NULL').c;
  return rep;
}

module.exports = { runStep, TREE };
