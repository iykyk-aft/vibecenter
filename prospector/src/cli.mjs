#!/usr/bin/env node
import { auditDeep, pageSpeed } from './audit-deep.mjs';
import { auditLite } from './audit-lite.mjs';
import { discover } from './discover.mjs';
import { writeDrafts } from './outreach.mjs';
import { writeCsv, writeHtml } from './report.mjs';
import { scoreProspect } from './score.mjs';
import { log, pool, readJson, writeJson } from './util.mjs';

const HELP = `Denver prospector: find small businesses with sub-par websites

  node src/cli.mjs discover [--manual file.csv|json ...] [--no-osm]   list Denver businesses (OpenStreetMap) + your own additions
                            (CSV columns: name,website,address,phone,email,category; --no-osm = only your file)
  node src/cli.mjs audit    [--limit N] [--concurrency 12] [--refresh]   fast HTTP/HTML audit of every site
  node src/cli.mjs deep     [--top 150] [--concurrency 4]   browser audit + screenshots of the worst candidates
  node src/cli.mjs score                                    combine everything into out/prospects.json
  node src/cli.mjs report                                   out/prospects.csv + out/report.html
  node src/cli.mjs draft    [--min-tier warm] [--limit 100] [--require-email]   out/drafts/*.md + drafts.csv
  node src/cli.mjs queue    [--limit 100]                   out/enrich-queue.json (for web-search enrichment)
  node src/cli.mjs all                                      score + report + draft
  node src/cli.mjs status                                   counts per stage

Enrichment (web search results) goes in out/enrichment.json:
  { "<id>": { "email": "", "website": "", "contactName": "", "stillOpen": true, "notes": "" } }
`;

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = Number.isNaN(+next) ? next : +next; i++; }
    if (key === 'manual') (opts.manualAll ||= []).push(opts[key]);
  }
  return { cmd, opts };
}

const load = () => ({
  businesses: readJson('businesses.json', []),
  lite: readJson('lite.json', {}),
  deep: readJson('deep.json', {}),
  psi: readJson('psi.json', {}),
  enrich: readJson('enrichment.json', {}),
});

function compile() {
  const { businesses, lite, deep, psi, enrich } = load();
  const out = businesses.map((b) => {
    const e = enrich[b.id] || {};
    const s = scoreProspect(b, lite[b.id], deep[b.id], psi[b.id], e);
    return {
      id: b.id, name: b.name, category: b.category, address: b.address, phone: b.phone,
      ...s,
      contactName: e.contactName || '',
      notes: e.notes || '',
      mobileShot: deep[b.id]?.mobileShot || '',
      desktopShot: deep[b.id]?.desktopShot || '',
    };
  }).filter((p) => p.score > 0);
  out.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  writeJson('prospects.json', out);
  return out;
}

const siteTargets = (businesses, enrich) =>
  businesses
    .map((b) => ({ b, url: enrich[b.id]?.website || (b.websiteKind === 'site' ? b.website : '') }))
    .filter((x) => x.url && enrich[x.b.id]?.stillOpen !== false);

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === 'discover') {
    const stats = await discover({ manualFiles: opts.manualAll || [], elements: opts['no-osm'] ? [] : undefined });
    log('discover:', stats);
  } else if (cmd === 'audit') {
    const { businesses, lite, enrich } = load();
    let todo = siteTargets(businesses, enrich).filter((x) => opts.refresh || !lite[x.b.id]);
    if (opts.limit) todo = todo.slice(0, opts.limit);
    log(`auditing ${todo.length} sites`);
    let n = 0;
    await pool(todo, opts.concurrency || 12, async ({ b, url }) => {
      lite[b.id] = await auditLite(url);
      if (++n % 25 === 0 || n === todo.length) { writeJson('lite.json', lite); log(`  ${n}/${todo.length}`); }
    });
    writeJson('lite.json', lite);
  } else if (cmd === 'deep') {
    const { businesses, lite, deep, psi } = load();
    const byId = new Map(businesses.map((b) => [b.id, b]));
    // Worst-looking reachable sites first, so the browser time goes where it matters.
    const ranked = compile().filter((p) => p.status === 'audited' && !deep[p.id]);
    const targets = ranked.slice(0, opts.top || 150).map((p) => ({ id: p.id, url: lite[p.id].finalUrl || lite[p.id].url }));
    log(`deep-auditing ${targets.length} sites`);
    await auditDeep(targets, {
      concurrency: opts.concurrency || 4,
      onResult: (r, i, total) => {
        deep[r.id] = r;
        log(`  ${i}/${total} ${byId.get(r.id)?.name} mobile:${r.mobile.ok ? `${r.mobile.loadMs}ms` : r.mobile.error}`);
        if (i % 10 === 0) writeJson('deep.json', deep);
      },
    });
    writeJson('deep.json', deep);
    if (process.env.PSI_API_KEY) {
      await pool(targets, 2, async ({ id, url }) => { const r = await pageSpeed(url); if (r) psi[id] = r; });
      writeJson('psi.json', psi);
    }
  } else if (cmd === 'score') {
    const p = compile();
    log(`scored ${p.length} prospects: hot=${p.filter((x) => x.tier === 'hot').length} warm=${p.filter((x) => x.tier === 'warm').length} cold=${p.filter((x) => x.tier === 'cold').length}`);
  } else if (cmd === 'report') {
    const p = compile();
    writeCsv(p);
    writeHtml(p, { total: p.length });
    log(`wrote out/prospects.csv and out/report.html (${p.length} prospects)`);
  } else if (cmd === 'draft') {
    const r = writeDrafts(compile(), { minTier: opts['min-tier'] || 'warm', limit: opts.limit || 100, requireEmail: !!opts['require-email'] });
    log('drafts:', r);
    if (r.missingSenderFields.length) log('  fill in out/sender.json (see sender.example.json) before sending anything:', r.missingSenderFields.join(', '));
  } else if (cmd === 'queue') {
    // Needs research: no contact email yet, or "no/dead site" cases worth verifying (is it really closed/missing?).
    const verify = ['no_website', 'social_only', 'site_down', 'parked'];
    const p = compile().filter((x) => !x.email || verify.includes(x.status)).slice(0, opts.limit || 100);
    writeJson('enrich-queue.json', p.map((x) => ({ id: x.id, name: x.name, category: x.category, address: x.address, phone: x.phone, status: x.status, website: x.website, topIssues: x.issues.slice(0, 3).map((i) => i.label) })));
    log(`queued ${p.length} for enrichment`);
  } else if (cmd === 'all') {
    const p = compile();
    writeCsv(p);
    writeHtml(p, { total: p.length });
    log('drafts:', writeDrafts(p, {}));
  } else if (cmd === 'status') {
    const { businesses, lite, deep, enrich } = load();
    const p = readJson('prospects.json', []);
    log({ businesses: businesses.length, withSite: businesses.filter((b) => b.websiteKind === 'site').length, audited: Object.keys(lite).length, deepAudited: Object.keys(deep).length, enriched: Object.keys(enrich).length, prospects: p.length });
  } else {
    console.log(HELP);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
