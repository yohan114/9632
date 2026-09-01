'use strict';

// The one true filter-number key.
//
// "C-115", "C115 (VIC Japan)" and "C 115" are one part; "FC-1503", "FC1503 / Sara" and
// "FC - 1503" are another. Upper-case it, drop anything in brackets (brand and supplier
// notes live there), then keep only letters and digits.
//
// This lived as a copy-paste in four files. It is a STORED join key — service_filters
// .filter_no_norm, filter_prices.filter_no_norm and filter_xrefs.part_number_norm are all
// written with it — so changing the rule silently re-points historical prices. Improve it
// only as a deliberate migration, never in passing.
const normF = (s) => String(s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z0-9]/g, '');

module.exports = { normF };
