'use strict';

// Phase 3 — Restore the project/site dimension. job_cards.site is populated (from the
// source "Site" column) but project_id was 100% NULL, so cost-by-project and the
// service-due advisory collapsed to "(unassigned)". This step:
//   • maps each job's free-text site to one of the 11 projects (keyword match on the
//     project name core + location), setting job_cards.project_id;
//   • derives each asset's current/home project from the dominant project of its jobs.
// Sites that don't map to a project (Badalgama, Katana, H/O, …) keep project_id NULL —
// the cost-by-site report covers the full location breakdown. Idempotent (re-derives).

const { get, all, run, tx } = require('../db');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function runStep() {
  const rep = { jobs_total: 0, jobs_projected: 0, sites_matched: 0, assets_projected: 0, unmatched_sites: [] };

  const keys = [];
  for (const p of all('SELECT id, name_norm, location FROM projects')) {
    const core = String(p.name_norm || '').replace(/(PROJECT|PLANT|WATER|ROAD|CITY|SITE)/g, '');
    const loc = norm(p.location);
    for (const kw of [core, loc]) if (kw && kw.length >= 4) keys.push({ id: p.id, kw });
  }
  const matchProject = (site) => {
    const s = norm(site); if (!s) return null;
    let best = null;
    for (const k of keys) if (s.includes(k.kw) || k.kw.includes(s)) { if (!best || k.kw.length > best.kw.length) best = k; }
    return best ? best.id : null;
  };

  const unmatched = {};
  tx(() => {
    run('UPDATE job_cards SET project_id = NULL');
    for (const j of all("SELECT id, site FROM job_cards WHERE site IS NOT NULL AND TRIM(site) <> ''")) {
      rep.jobs_total++;
      const pid = matchProject(j.site);
      if (pid) { run('UPDATE job_cards SET project_id = ? WHERE id = ?', pid, j.id); rep.jobs_projected++; }
      else unmatched[j.site] = (unmatched[j.site] || 0) + 1;
    }
    for (const a of all('SELECT id FROM assets')) {
      const top = get(
        `SELECT project_id, COUNT(*) c FROM job_cards WHERE asset_id = ? AND project_id IS NOT NULL
          GROUP BY project_id ORDER BY c DESC LIMIT 1`, a.id
      );
      if (top && top.project_id) {
        run('UPDATE assets SET current_project_id = ?, home_project_id = COALESCE(home_project_id, ?) WHERE id = ?', top.project_id, top.project_id, a.id);
        rep.assets_projected++;
      }
    }
  });

  rep.sites_matched = all('SELECT DISTINCT site FROM job_cards WHERE project_id IS NOT NULL').length;
  rep.unmatched_sites = Object.entries(unmatched).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, c]) => `${s} (${c})`);
  return rep;
}

module.exports = { runStep };
