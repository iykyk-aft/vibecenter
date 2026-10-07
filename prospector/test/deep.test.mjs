import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { analyzeHtml } from '../src/audit-lite.mjs';
import { scoreProspect } from '../src/score.mjs';
import { DESKTOP_ONLY_PAGE, FIXED_WITH_VIEWPORT_PAGE, startServer } from './fixtures.mjs';

// Screenshots must land in a temp dir, never the real out/ folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-test-'));
process.env.PROSPECTOR_OUT = tmp;
const { auditDeep, findChromium } = await import('../src/audit-deep.mjs');

let srv;
before(async () => { srv = await startServer(); });
after(() => { srv.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('browser audit tells responsive, zoomed-out and sideways-scrolling pages apart', { skip: !findChromium() && 'no Chromium found' }, async () => {
  const [good, desktop, fixed] = await auditDeep(
    [{ id: 'good', url: `${srv.base}/good` }, { id: 'desktop', url: `${srv.base}/desktop` }, { id: 'fixed', url: `${srv.base}/fixed` }],
    { concurrency: 3 },
  );
  for (const r of [good, desktop, fixed]) assert.equal(r.mobile.ok, true, r.mobile.error);

  // Responsive page: no overflow, no zoom-out, readable.
  assert.ok(good.mobile.overflowX <= 0, `overflowed by ${good.mobile.overflowX}px`);
  assert.equal(good.mobile.pageScale, 1);
  assert.equal(good.mobile.hasH1, true);
  assert.ok(good.mobile.smallTextRatio < 0.1);
  assert.ok(fs.statSync(path.join(tmp, good.mobileShot)).size > 1000, 'mobile screenshot written');
  assert.ok(fs.statSync(path.join(tmp, good.desktopShot)).size > 1000, 'desktop screenshot written');

  // Desktop-only page, no viewport tag: phone zooms it out (overflow reads 0, so scale is the signal).
  assert.ok(desktop.mobile.pageScale < 0.5, `pageScale ${desktop.mobile.pageScale}`);
  assert.ok(desktop.mobile.smallTextRatio > 0.5, `smallTextRatio ${desktop.mobile.smallTextRatio}`);

  // Same layout with a viewport tag: no zoom-out, so it scrolls sideways instead.
  assert.equal(fixed.mobile.pageScale, 1);
  assert.ok(fixed.mobile.overflowX > 100, `overflowX ${fixed.mobile.overflowX}`);
});

test('deep findings reach the score without double-counting the viewport problem', { skip: !findChromium() && 'no Chromium found' }, async () => {
  const [desktop, fixed] = await auditDeep(
    [{ id: 'd2', url: `${srv.base}/desktop` }, { id: 'f2', url: `${srv.base}/fixed` }], { concurrency: 2 },
  );
  const lite = (html) => ({ reachable: true, https: true, ttfbMs: 100, ...analyzeHtml(html, 'https://t.test/') });
  const biz = { id: 'x', name: 'Mile High Auto', category: 'car_repair', websiteKind: 'site', website: 'https://t.test', phone: '', hours: '' };
  const codes = (s) => s.issues.map((i) => i.code);

  const sDesktop = scoreProspect(biz, lite(DESKTOP_ONLY_PAGE), desktop);
  assert.ok(codes(sDesktop).includes('no_viewport') && codes(sDesktop).includes('shrunk_to_fit'), codes(sDesktop).join());
  assert.equal(sDesktop.issues.find((i) => i.code === 'shrunk_to_fit').pts, 6, 'corroboration only when viewport tag is missing');

  const sFixed = scoreProspect(biz, lite(FIXED_WITH_VIEWPORT_PAGE), fixed);
  assert.ok(codes(sFixed).includes('mobile_overflow'), codes(sFixed).join());
  assert.ok(!codes(sFixed).includes('no_viewport'));
});
