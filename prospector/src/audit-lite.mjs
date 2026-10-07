import { UA } from './config.mjs';
import { hostOf } from './util.mjs';

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PROTOCOL_ERROR', 'ERR_SSL_UNRECOGNIZED_NAME_ALERT',
]);

const errCode = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : e?.cause?.code || e?.code || e?.message || 'error');

async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks = [];
  let bytes = 0;
  while (bytes < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
  }
  reader.cancel().catch(() => {});
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), bytes };
}

export async function fetchPage(url, timeoutMs = 20_000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
    });
    const ttfbMs = Date.now() - t0;
    const { text, bytes } = await readCapped(res, 2_000_000);
    return {
      ok: true, status: res.status, finalUrl: res.url, ttfbMs, totalMs: Date.now() - t0,
      headers: Object.fromEntries(res.headers), html: text, bytes,
    };
  } catch (e) {
    const code = errCode(e);
    return { ok: false, error: code, tls: TLS_CODES.has(code) };
  }
}

const BUILDERS = [
  ['wix', /wixstatic\.com|wix\.com\/|x-wix-/i],
  ['squarespace', /squarespace\.com|static1\.squarespace/i],
  ['godaddy', /godaddy|secureserver\.net|websitebuilder\.godaddy|img1\.wsimg\.com/i],
  ['weebly', /weebly\.com|editmysite\.com/i],
  ['shopify', /cdn\.shopify\.com|shopify\.theme/i],
  ['webflow', /webflow\.(com|io)|data-wf-page/i],
  ['wordpress', /wp-content|wp-includes|wp-json/i],
  ['joomla', /\/media\/jui\/|joomla/i],
  ['drupal', /drupal-settings-json|sites\/default\/files/i],
  ['duda', /dudaone|duda_|multiscreensite/i],
  ['yola/other-template', /yolasite|jimdo(free|site)|site123|strikingly/i],
];

// Word boundaries matter: "All rights reserved" and "stock" must not count as booking.
const BOOKING_RE = /\bbook\s*(now|online|an?\s*appointment)|\breserve\s+(a|your|now|online|table)|\breservations?\b|schedule\s*(an?\s*)?(appointment|visit|consult)|order\s*online|request\s*(an?\s*)?(quote|appointment|estimate)|opentable|resy\.com|toasttab|squareup\.com|square\.site|calendly|acuity|vagaro|mindbody|booksy|setmore|exploretock|tock\.com|doordash|ubereats/i;
const PARKED_RE = /domain\s+(name\s+)?is\s+for\s+sale|buy\s+this\s+domain|this\s+domain\s+(may\s+be|is)\s+(for\s+sale|parked)|parked\s+(free|domain)|sedoparking|hugedomains|dan\.com\/buy|under\s+construction|coming\s+soon\s*!?\s*<\/|website\s+(is\s+)?(expired|suspended)|account\s+suspended/i;
const BAD_EMAIL_DOMAIN = /(^|\.)(sentry(-next)?\.|wixpress|example|domain|email|yourdomain|sentry\.io|godaddy|squarespace|shopify|wordpress|schema|w3)\./i;

const stripTags = (html) =>
  html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();

function meta(html, name) {
  const re1 = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
  return (html.match(re1) || html.match(re2) || [])[1] || '';
}

export function extractEmails(html, siteHost) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) found.add(m[1].toLowerCase());
  for (const m of html.matchAll(/\b([a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi)) found.add(m[1].toLowerCase());
  const ok = [...found].filter((e) => {
    const [local, domain] = e.split('@');
    return !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(e) && !BAD_EMAIL_DOMAIN.test(`${domain}.`) && !/^\d+x?$/.test(local) && local.length <= 40;
  });
  const own = ok.filter((e) => e.split('@')[1].endsWith(siteHost));
  return [...own, ...ok.filter((e) => !own.includes(e))].slice(0, 3);
}

/** Pure HTML heuristics: no network, no browser. */
export function analyzeHtml(html, finalUrl = '') {
  const lower = html.toLowerCase();
  const text = stripTags(html);
  const yearNow = new Date().getFullYear();

  const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:&copy;|©)?\s*(?:\d{4}\s*(?:-|–|&ndash;|to)\s*)?((?:19|20)\d\d)/gi)].map((m) => +m[1]);
  const copyrightYear = years.length ? Math.max(...years) : null;

  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  let jquery = null;
  for (const s of scripts) {
    const m = s.match(/jquery[-./]v?(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (m) { jquery = `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}`; break; }
  }

  const generator = meta(html, 'generator');
  const wpVer = generator.match(/wordpress\s+(\d+)\.(\d+)/i);
  const builder = BUILDERS.find(([, re]) => re.test(html))?.[0] || '';

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgsNoAlt = imgs.filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;

  const tables = (html.match(/<table\b/gi) || []).length;
  const divs = (html.match(/<div\b/gi) || []).length;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim() || '';

  const hasTel = /href=["']tel:/i.test(html);
  const hasMailto = /href=["']mailto:/i.test(html);
  const hasForm = /<form\b/i.test(html);
  const hasBooking = BOOKING_RE.test(html);

  return {
    title,
    metaDescription: meta(html, 'description'),
    viewport: meta(html, 'viewport'),
    lang: (html.match(/<html[^>]+lang=["']([^"']+)["']/i) || [])[1] || '',
    h1Count: (html.match(/<h1\b/gi) || []).length,
    og: !!(meta(html, 'og:title') || meta(html, 'og:image')),
    generator,
    builder,
    wpOld: !!(wpVer && +wpVer[1] < 6),
    jquery,
    jqueryOld: !!(jquery && +jquery.split('.')[0] < 3),
    copyrightYear,
    copyrightAge: copyrightYear ? yearNow - copyrightYear : null,
    flash: /\.swf\b|<object[^>]+(shockwave|flash)|<embed[^>]+\.swf/i.test(lower),
    frames: /<frameset\b|<frame\b/i.test(lower),
    legacyTags: /<marquee\b|<blink\b|<center\b|<font\b/i.test(lower),
    tableLayout: tables >= 4 && divs < 15,
    hasTel, hasMailto, hasForm, hasBooking,
    hasCta: hasTel || hasMailto || hasForm || hasBooking,
    imgCount: imgs.length,
    imgsNoAlt,
    textLength: text.length,
    parked: PARKED_RE.test(text.slice(0, 4000)) || (text.length < 200 && PARKED_RE.test(html)),
    spaShell: text.length < 200 && /<div id=["'](root|app|__next)["']/i.test(html),
    mixedContent: /^https:/i.test(finalUrl) && /(?:src|href)=["']http:\/\/(?!schemas|www\.w3)/i.test(html),
  };
}

function contactLink(html, baseUrl) {
  try {
    const base = new URL(baseUrl);
    for (const m of html.matchAll(/<a\b[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
      if (/contact|reach-us|get-in-touch|about/i.test(m[1] + m[2])) {
        const u = new URL(m[1], base);
        if (hostOf(u.href) === hostOf(base.href) && /^https?:$/.test(u.protocol)) return u.href;
      }
    }
  } catch { /* ignore bad hrefs */ }
  return '';
}

/** Fetch one site's homepage (plus a contact page if no email found) and extract signals. */
export async function auditLite(rawUrl) {
  const host = hostOf(rawUrl);
  let page = await fetchPage(rawUrl);
  let httpsFailed = null;
  if (!page.ok && /^https:/i.test(rawUrl)) {
    // Distinguish "bad/expired certificate" from "site is gone" by trying plain http.
    const http = await fetchPage(rawUrl.replace(/^https:/i, 'http:'));
    if (http.ok) { httpsFailed = { error: page.error, tls: page.tls }; page = http; }
  }
  const base = { url: rawUrl, host, checkedAt: new Date().toISOString() };
  if (!page.ok) return { ...base, reachable: false, error: page.error, tls: !!page.tls };

  const finalUrl = page.finalUrl;
  const a = analyzeHtml(page.html, finalUrl);
  const finalHost = hostOf(finalUrl);
  let emails = extractEmails(page.html, host);
  if (!emails.length && page.status < 400) {
    const link = contactLink(page.html, finalUrl);
    if (link) {
      const cp = await fetchPage(link, 12_000);
      if (cp.ok) emails = extractEmails(cp.html, host);
    }
  }
  return {
    ...base,
    reachable: page.status < 400,
    status: page.status,
    finalUrl,
    https: /^https:/i.test(finalUrl),
    httpsFailed,
    redirectedOffsite: finalHost !== host && !finalHost.endsWith(`.${host}`) && !host.endsWith(`.${finalHost}`),
    ttfbMs: page.ttfbMs,
    totalMs: page.totalMs,
    htmlBytes: page.bytes,
    server: page.headers.server || '',
    poweredBy: page.headers['x-powered-by'] || '',
    lastModified: page.headers['last-modified'] || '',
    emails,
    ...a,
  };
}
