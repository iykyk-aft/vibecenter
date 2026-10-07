import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { analyzeHtml, auditLite, extractEmails } from '../src/audit-lite.mjs';
import { classifyWebsite, filterSmallBusinesses, inDenver, toBusiness } from '../src/discover.mjs';
import { draftFor, subjectFor } from '../src/outreach.mjs';
import { scoreProspect } from '../src/score.mjs';
import { parseCsv, toCsv } from '../src/util.mjs';
import { BAD_PAGE, GOOD_PAGE, startServer } from './fixtures.mjs';

const biz = (o = {}) => ({ id: 'x', name: 'Test Co', category: 'plumber', websiteKind: 'site', website: 'http://t.test', phone: '', hours: '', ...o });
const codes = (s) => s.issues.map((i) => i.code);

describe('analyzeHtml', () => {
  test('flags a dated page', () => {
    const a = analyzeHtml(BAD_PAGE, 'http://joesplumbing.test/');
    assert.equal(a.viewport, '');
    assert.equal(a.copyrightYear, 2012);
    assert.equal(a.jqueryOld, true);
    assert.equal(a.legacyTags, true);
    assert.equal(a.tableLayout, true);
    assert.equal(a.hasCta, false);
    assert.equal(a.title, 'Home');
  });
  test('passes a modern page', () => {
    const a = analyzeHtml(GOOD_PAGE, 'https://x.test/');
    assert.ok(a.viewport.includes('width=device-width'));
    assert.equal(a.copyrightAge, 0);
    assert.equal(a.hasCta, true);
    assert.equal(a.hasBooking, true);
    assert.equal(a.legacyTags, false);
    assert.equal(a.tableLayout, false);
    assert.equal(a.og, true);
  });
  test('"all rights reserved" and "stock" are not booking signals', () => {
    assert.equal(analyzeHtml('<footer>All rights reserved. In stock now.</footer>').hasBooking, false);
    assert.equal(analyzeHtml('<a>Reserve a table</a>').hasBooking, true);
  });
  test('detects parked pages and builders', () => {
    assert.equal(analyzeHtml('<html><body><h1>This domain is for sale</h1></body></html>').parked, true);
    assert.equal(analyzeHtml('<img src="https://img1.wsimg.com/a.png"><p>hi</p>').builder, 'godaddy');
  });
  test('extractEmails prefers the site domain and drops junk', () => {
    const html = 'a@sentry.io b@gmail.com <a href="mailto:Joe@Shop.com">x</a> logo@2x.png';
    assert.deepEqual(extractEmails(html, 'shop.com'), ['joe@shop.com', 'b@gmail.com']);
  });
});

describe('scoreProspect', () => {
  const lite = (html, o = {}) => ({ reachable: true, https: true, ttfbMs: 300, ...analyzeHtml(html, 'https://t.test/'), ...o });

  test('dated site outscores a modern one', () => {
    const bad = scoreProspect(biz(), lite(BAD_PAGE, { https: false }));
    const good = scoreProspect(biz({ category: 'dentist' }), lite(GOOD_PAGE));
    assert.ok(bad.score >= 80, `bad=${bad.score}`);
    assert.ok(good.score < 15, `good=${good.score} ${codes(good)}`);
    assert.equal(bad.tier, 'hot');
    assert.ok(codes(bad).includes('no_https') && codes(bad).includes('no_viewport'));
  });
  test('no website, social-only, down, and closed', () => {
    assert.equal(scoreProspect(biz({ websiteKind: 'none', website: '' })).status, 'no_website');
    assert.equal(scoreProspect(biz({ websiteKind: 'social' })).status, 'social_only');
    assert.equal(scoreProspect(biz(), { reachable: false, error: 'ENOTFOUND' }).status, 'site_down');
    assert.equal(scoreProspect(biz({ websiteKind: 'none' }), null, null, null, { stillOpen: false }).score, 0);
  });
  test('enrichment website turns "no website" into an audit target', () => {
    assert.equal(scoreProspect(biz({ websiteKind: 'none', website: '' }), null, null, null, { website: 'https://found.test' }).status, 'unaudited');
  });
  test('email on file ranks a prospect higher', () => {
    const l = lite(BAD_PAGE);
    assert.ok(scoreProspect(biz({ email: 'a@b.co' }), l).rank > scoreProspect(biz(), l).rank);
  });
  test('mobile overflow and slow load come from the browser audit', () => {
    const deep = { mobile: { ok: true, overflowX: 300, loadMs: 9000, transferBytes: 6e6, smallTextRatio: 0, tapTargets: 0, smallTaps: 0, brokenImages: 0, bodyTextLength: 900 }, desktop: { ok: true } };
    const s = scoreProspect(biz(), lite(GOOD_PAGE), deep);
    assert.ok(codes(s).includes('mobile_overflow') && codes(s).includes('slow_load') && codes(s).includes('heavy_page'), codes(s).join());
  });
});

describe('discover', () => {
  const el = (id, tags, extra = {}) => ({ type: 'node', id, lat: 39.74, lon: -104.99, tags, ...extra });

  test('toBusiness maps OSM tags', () => {
    const b = toBusiness(el(1, { name: 'Joe\'s', shop: 'bakery', website: 'joes.test', 'addr:housenumber': '12', 'addr:street': 'Main St' }));
    assert.equal(b.category, 'bakery');
    assert.equal(b.websiteKind, 'site');
    assert.equal(b.website, 'https://joes.test');
    assert.equal(b.address, '12 Main St');
  });
  test('classifyWebsite spots social-only and empty values', () => {
    assert.equal(classifyWebsite('https://www.facebook.com/joes').kind, 'social');
    assert.equal(classifyWebsite('').kind, 'none');
    assert.equal(classifyWebsite('not a url').kind, 'none');
  });
  test('filterSmallBusinesses drops chains and institutions', () => {
    const list = [
      toBusiness(el(1, { name: 'Local Bakery', shop: 'bakery' })),
      toBusiness(el(2, { name: 'BigCo', shop: 'supermarket', brand: 'BigCo' })),
      toBusiness(el(3, { name: 'Quick Mart', shop: 'convenience' })),
      toBusiness(el(4, { name: 'Quick Mart', shop: 'convenience' })),
      toBusiness(el(5, { name: 'Quick Mart', shop: 'convenience' })),
      toBusiness(el(6, { name: 'Starbucks Reserve', amenity: 'cafe', website: 'https://www.starbucks.com/x' })),
      toBusiness(el(7, { name: 'State Agency', office: 'government' })),
    ];
    const { kept, dropped } = filterSmallBusinesses(list);
    assert.deepEqual(kept.map((b) => b.name), ['Local Bakery']);
    assert.equal(dropped.length, 6);
  });
  test('inDenver rejects far-away coordinates', () => {
    assert.equal(inDenver({ lat: 39.74, lon: -104.99 }), true);
    assert.equal(inDenver({ lat: 35.5, lon: -81.0 }), false);
  });
});

describe('report', () => {
  test('hostile business names cannot break out of the embedded JSON or inject markup', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-report-'));
    process.env.PROSPECTOR_OUT = tmp;
    try {
      const { writeHtml } = await import('../src/report.mjs');
      const evil = '</script><script>window.__pwned=1</script><img src=x onerror=alert(1)>';
      writeHtml([{ id: 'e', name: evil, category: 'x', address: '', phone: '', email: '', website: 'javascript:alert(1)', tier: 'hot', score: 90, status: 'audited', issues: [{ label: evil, pts: 5 }] }]);
      const html = fs.readFileSync(path.join(tmp, 'report.html'), 'utf8');
      const dataBlock = html.slice(html.indexOf('id="data"'), html.indexOf('const D=JSON.parse'));
      assert.ok(!dataBlock.includes('</script><script>'), 'data block must not contain a raw </script>');
      assert.equal((html.match(/<script/g) || []).length, 2, 'only the two real script tags');
      assert.ok(dataBlock.includes('\\u003c/script>'), 'less-than is escaped inside the JSON');
    } finally {
      delete process.env.PROSPECTOR_OUT;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('util + outreach', () => {
  test('csv round-trips quotes, commas and newlines', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2' }];
    assert.deepEqual(parseCsv(toCsv(rows, ['a', 'b', 'c'])), rows);
  });
  test('draft cites specific findings and carries opt-out + address', () => {
    const s = scoreProspect(biz({ name: 'Joe Plumbing' }), { reachable: true, https: false, ttfbMs: 100, ...analyzeHtml(BAD_PAGE, 'http://j.test/') });
    const p = { name: 'Joe Plumbing', category: 'plumber', ...s };
    const sender = { name: 'Sam', business: 'Sam Web', email: 's@w.co', phone: '555', address: '1 Main St, Denver, CO', portfolio: '[LINK TO YOUR PORTFOLIO]' };
    const d = draftFor(p, sender);
    assert.match(d, /Joe Plumbing/);
    assert.match(d, /reply "no thanks"/);
    assert.match(d, /1 Main St, Denver, CO/);
    assert.ok(subjectFor(p).includes('Joe Plumbing'));
  });
});

describe('auditLite (local server)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.server.close());

  test('audits a reachable bad page', async () => {
    const r = await auditLite(`${srv.base}/bad`);
    assert.equal(r.reachable, true);
    assert.equal(r.https, false);
    assert.equal(r.jqueryOld, true);
    assert.deepEqual(r.emails, ['joe@joesplumbing.test']);
  });
  test('404 and connection refused are not reachable', async () => {
    assert.equal((await auditLite(`${srv.base}/missing`)).reachable, false);
    // A port that was just freed: nothing is listening. (Port 1 is on undici's blocked list.)
    const probe = await startServer();
    const closedUrl = `${probe.base}/`;
    await new Promise((r) => probe.server.close(r));
    const refused = await auditLite(closedUrl);
    assert.equal(refused.reachable, false);
    assert.equal(refused.error, 'ECONNREFUSED');
  });
  test('parked page is detected', async () => {
    assert.equal((await auditLite(`${srv.base}/parked`)).parked, true);
  });
});
