import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';
import { UA } from './config.mjs';
import { ensureOut, log, pool } from './util.mjs';

export function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    const link = path.join(base, 'chromium');
    if (fs.existsSync(link) && fs.statSync(link).isFile()) return link;
    for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // fall back to Playwright's own download (npx playwright install chromium)
}

/** Runs inside the page. Returns plain numbers/booleans only. */
function pageMetrics() {
  const doc = document.documentElement;
  const body = document.body;
  // Mobile Chromium widens the *layout* viewport (innerWidth) to fit overflowing content, so
  // innerWidth can't be the baseline. What the visitor sees is the *visual* viewport:
  //  - fixed-width page WITH a viewport tag: layout 1240px, visual stays 390px -> sideways scroll
  //  - page with NO viewport tag: layout 1240px, zoomed out to ~31%            -> tiny text
  // Real on-screen sizes are CSS px * scale.
  const scale = window.visualViewport?.scale ?? 1;
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0;
  };

  let textChars = 0;
  let smallChars = 0;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (t.length < 3 || !el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || !visible(el)) continue;
    textChars += t.length;
    if (parseFloat(getComputedStyle(el).fontSize) * scale < 12) smallChars += t.length;
  }

  const taps = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select')].filter(visible);
  const smallTaps = taps.filter((el) => {
    const r = el.getBoundingClientRect();
    return Math.min(r.width, r.height) * scale < 24;
  }).length;

  const brokenImages = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src && visible(i)).length;
  const wide = [...body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > vw + 8 && visible(el)).length;
  const bodyText = body.innerText || '';

  return {
    viewportWidth: vw,
    pageScale: +scale.toFixed(2),
    overflowX: Math.max(doc.scrollWidth, body.scrollWidth) - vw,
    elementsWiderThanViewport: wide,
    textChars,
    smallTextRatio: textChars ? +(smallChars / textChars).toFixed(2) : 0,
    tapTargets: taps.length,
    smallTaps,
    brokenImages,
    hasH1: !!document.querySelector('h1'),
    phoneVisible: /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(bodyText),
    bodyTextLength: bodyText.trim().length,
  };
}

async function loadAndCapture(browser, url, contextOpts, shotPath) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  const consoleErrors = [];
  let failedRequests = 0;
  let transferBytes = 0;
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 120)));
  page.on('requestfailed', () => { failedRequests++; });
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.loadingFinished', (e) => { transferBytes += e.encodedDataLength || 0; });

    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(1500);
    const metrics = await page.evaluate(pageMetrics);
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 55 });
    return { ok: true, loadMs, transferBytes, consoleErrors: consoleErrors.length, failedRequests, ...metrics };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 160) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function auditDeepOne(browser, id, url) {
  const dir = ensureOut('screenshots');
  const mobileShot = path.join(dir, `${id}-mobile.jpg`);
  const desktopShot = path.join(dir, `${id}-desktop.jpg`);
  const mobile = await loadAndCapture(browser, url, { ...devices['iPhone 13'] }, mobileShot);
  const desktop = await loadAndCapture(
    browser, url, { viewport: { width: 1366, height: 768 }, userAgent: UA }, desktopShot,
  );
  return {
    id, url, checkedAt: new Date().toISOString(),
    mobile, desktop,
    mobileShot: mobile.ok ? `screenshots/${id}-mobile.jpg` : '',
    desktopShot: desktop.ok ? `screenshots/${id}-desktop.jpg` : '',
  };
}

export async function auditDeep(targets, { concurrency = 4, onResult } = {}) {
  const executablePath = findChromium();
  // Honor a standard outbound proxy (corporate network, sandboxes); a no-op on a normal machine.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      // Audit only the target sites: stop Chromium's own background calls (updater, sync, safe-browsing, etc.).
      args: [
        '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--disable-default-apps', '--disable-client-side-phishing-detection', '--no-default-browser-check',
        '--no-first-run', '--metrics-recording-only', '--disable-features=OptimizationHints,Translate,MediaRouter',
      ],
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: 'localhost,127.0.0.1' } } : {}),
    });
  } catch (e) {
    throw new Error(`could not launch Chromium (${e.message.split('\n')[0]}). Set CHROMIUM_PATH or run: npx playwright install chromium`);
  }
  try {
    let done = 0;
    return await pool(targets, concurrency, async ({ id, url }) => {
      const r = await auditDeepOne(browser, id, url);
      onResult?.(r, ++done, targets.length);
      return r;
    });
  } finally {
    await browser.close();
  }
}

/** Optional: Google PageSpeed Insights (mobile). Needs PSI_API_KEY for any real volume. */
export async function pageSpeed(url, key = process.env.PSI_API_KEY) {
  if (!key) return null;
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&category=seo&category=accessibility&url=${encodeURIComponent(url)}&key=${key}`;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) { log(`psi ${res.status} for ${url}`); return null; }
    const j = await res.json();
    const c = j.lighthouseResult?.categories || {};
    const a = j.lighthouseResult?.audits || {};
    return {
      performance: c.performance?.score != null ? Math.round(c.performance.score * 100) : null,
      seo: c.seo?.score != null ? Math.round(c.seo.score * 100) : null,
      accessibility: c.accessibility?.score != null ? Math.round(c.accessibility.score * 100) : null,
      lcpMs: Math.round(a['largest-contentful-paint']?.numericValue || 0) || null,
    };
  } catch (e) {
    log(`psi error for ${url}: ${e.message}`);
    return null;
  }
}
