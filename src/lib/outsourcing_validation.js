'use strict';

/**
 * Validation logic for CCOM Outsourced Service & Repair Requests
 *
 * Implements strict input sanitization, field checks, CR/LF injection
 * prevention, and state-transition rules as required by the CCOM plan.
 */

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function sanitizeOneLine(v) {
  if (!v) return '';
  return String(v).replace(/[\r\n\x00-\x1F\x7F]+/g, ' ').trim();
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const cleaned = email.trim();
  if (/[\r\n]/.test(cleaned)) return false; // Reject CRLF injection
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
}

function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

/**
 * Validate draft creation payload
 */
function validateDraftPayload(b) {
  const errors = [];

  const repairJobId = b.repair_job_id ? Number(b.repair_job_id) : null;
  const serviceRecId = b.service_record_id ? Number(b.service_record_id) : null;

  if (!repairJobId && !serviceRecId) {
    errors.push('A CCOM request must be linked to either an ongoing Repair Job or a Service Record.');
  }
  if (repairJobId && serviceRecId) {
    errors.push('A CCOM request cannot be linked to both a Repair Job and a Service Record.');
  }

  const vendorId = Number(b.vendor_id);
  if (!vendorId || vendorId <= 0) {
    errors.push('Valid vendor_id is required.');
  }

  const reqType = clean(b.request_type) || (serviceRecId ? 'service' : 'repair');
  if (!['repair', 'service'].includes(reqType)) {
    errors.push("request_type must be either 'repair' or 'service'.");
  }

  if (b.required_date && !isValidDate(b.required_date)) {
    errors.push('required_date must be a valid date in YYYY-MM-DD format.');
  }

  const meter = b.meter_reading != null && b.meter_reading !== '' ? Number(b.meter_reading) : null;
  if (meter !== null && (isNaN(meter) || meter < 0)) {
    errors.push('meter_reading must be a non-negative number.');
  }

  const meterUnit = clean(b.meter_unit) || 'hours';
  if (!['hours', 'km', 'miles'].includes(meterUnit)) {
    errors.push("meter_unit must be 'hours' or 'km'.");
  }

  // Validate lines if provided
  let lines = [];
  if (Array.isArray(b.lines)) {
    lines = b.lines.map((l, i) => {
      const desc = sanitizeOneLine(l.description || l.work_description);
      const loc = sanitizeOneLine(l.location);
      const rem = sanitizeOneLine(l.remarks);
      if (!desc) {
        errors.push(`Line ${i + 1}: Description cannot be empty.`);
      }
      return {
        line_no: i + 1,
        description: desc,
        location: loc || null,
        remarks: rem || null
      };
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      repair_job_id: repairJobId,
      service_record_id: serviceRecId,
      vendor_id: vendorId,
      vendor_contact_id: b.vendor_contact_id ? Number(b.vendor_contact_id) : null,
      assigned_engineer_id: b.assigned_engineer_id ? Number(b.assigned_engineer_id) : null,
      request_type: reqType,
      required_date: b.required_date ? b.required_date.slice(0, 10) : null,
      priority: ['urgent', 'high', 'low'].includes(clean(b.priority)) ? clean(b.priority) : 'normal',
      meter_reading: meter,
      meter_unit: meterUnit,
      contact_name: sanitizeOneLine(b.contact_name),
      contact_number: sanitizeOneLine(b.contact_number),
      informed_by: sanitizeOneLine(b.informed_by),
      lines
    }
  };
}

/**
 * Validate request ready for submission to Engineer
 */
function validateSubmission(request, lines) {
  const errors = [];
  if (!request) {
    return { valid: false, errors: ['Request record not found.'] };
  }
  if (!request.assigned_engineer_id) {
    errors.push('A Mechanical Engineer must be assigned before submitting the request for approval.');
  }
  if (!lines || lines.length === 0) {
    errors.push('At least one repair/service line item is required.');
  } else {
    lines.forEach((l, i) => {
      if (!l.description || !l.description.trim()) {
        errors.push(`Item ${i + 1} has an empty description.`);
      }
    });
  }
  if (request.status !== 'draft' && request.status !== 'returned') {
    errors.push(`Cannot submit a request currently in '${request.status}' state.`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate email queue payload
 */
function validateEmailPayload(b) {
  const errors = [];

  let to = [];
  let rawTo = b.to;
  if (typeof rawTo === 'string') {
    rawTo = rawTo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(rawTo) && rawTo.length) {
    for (const r of rawTo) {
      const email = typeof r === 'string' ? r.trim() : (r && r.email ? String(r.email).trim() : '');
      const name = typeof r === 'object' && r ? r.name : '';
      if (!isValidEmail(email)) {
        errors.push(`Invalid recipient email address: '${email}'`);
      } else {
        to.push({ email: sanitizeOneLine(email), name: sanitizeOneLine(name) || null });
      }
    }
  }
  if (!to.length && !errors.length) {
    errors.push('At least one valid recipient email is required.');
  }

  let cc = [];
  let rawCc = b.cc;
  if (typeof rawCc === 'string') {
    rawCc = rawCc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(rawCc)) {
    for (const r of rawCc) {
      const email = typeof r === 'string' ? r.trim() : (r && r.email ? String(r.email).trim() : '');
      const name = typeof r === 'object' && r ? r.name : '';
      if (email) {
        if (!isValidEmail(email)) {
          errors.push(`Invalid CC recipient email address: '${email}'`);
        } else {
          cc.push({ email: sanitizeOneLine(email), name: sanitizeOneLine(name) || null });
        }
      }
    }
  }

  const subject = sanitizeOneLine(b.subject);
  if (!subject) {
    errors.push('Email subject cannot be empty.');
  }
  if (/[\r\n]/.test(b.subject || '')) {
    errors.push('Subject contains illegal header injection characters.');
  }

  const body = String(b.body || '').trim();

  return {
    valid: errors.length === 0,
    errors,
    data: {
      to,
      cc,
      subject,
      body
    }
  };
}

module.exports = {
  clean,
  sanitizeOneLine,
  isValidEmail,
  isValidDate,
  validateDraftPayload,
  validateSubmission,
  validateEmailPayload
};
