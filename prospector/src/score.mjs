import { BOOKING_CATEGORIES, HIGH_VALUE_CATEGORIES } from './config.mjs';

const secs = (ms) => Math.round(ms / 100) / 10;
const mobile = (c) => (c.deep?.mobile?.ok ? c.deep.mobile : null);
const desktop = (c) => (c.deep?.desktop?.ok ? c.deep.desktop : null);

/**
 * Issue rules. `pts` is how bad it is (and how easy it is to sell a fix for). Scores are
 * summed and capped at 100. `pitch` completes the sentence "I noticed that ...".
 */
export const RULES = [
  // --- site-level problems (only evaluated when the site was fetched) ---
  { code: 'tls_error', pts: 30, label: 'Browser security warning (bad/expired certificate)',
    when: (c) => !!c.lite.httpsFailed?.tls,
    pitch: () => 'browsers show a scary security warning when people open your website (the SSL certificate is expired or misconfigured)' },
  { code: 'no_https', pts: 25, label: 'Not served over HTTPS ("Not secure")',
    when: (c) => c.lite.reachable && !c.lite.https && !c.lite.httpsFailed?.tls,
    pitch: () => 'Chrome flags your site as "Not secure" because it isn\'t served over HTTPS' },
  { code: 'no_viewport', pts: 25, label: 'Not mobile-friendly (no viewport meta)',
    when: (c) => !c.lite.viewport && !c.lite.spaShell,
    pitch: () => 'the site isn\'t built for phones, so mobile visitors have to pinch and zoom to read anything' },
  // Desktop-only layout: the phone browser zooms the whole page out. If there's no viewport tag,
  // `no_viewport` already explains it, so this is only corroboration (fewer points, no double count).
  { code: 'shrunk_to_fit', pts: (c) => (c.lite.viewport ? 20 : 6),
    label: (c) => `Page shrinks to ${Math.round(mobile(c).pageScale * 100)}% on phones`,
    when: (c) => (mobile(c)?.pageScale ?? 1) < 0.8,
    pitch: (c) => `on a phone the whole page is shrunk to about ${Math.round(mobile(c).pageScale * 100)}% of its size, so the text is too small to read without zooming` },
  { code: 'mobile_overflow', pts: 18, label: 'Page scrolls sideways on a phone',
    when: (c) => (mobile(c)?.overflowX ?? 0) > 20,
    pitch: () => 'on a phone the page scrolls sideways and some content gets cut off' },
  { code: 'small_text', pts: 8, label: 'Tiny text on mobile',
    when: (c) => (mobile(c)?.smallTextRatio ?? 0) > 0.3,
    pitch: () => 'a lot of the text is too small to read comfortably on a phone' },
  { code: 'small_taps', pts: 6, label: 'Tap targets too small on mobile',
    when: (c) => (mobile(c)?.tapTargets ?? 0) >= 8 && mobile(c).smallTaps / mobile(c).tapTargets > 0.6,
    pitch: () => 'buttons and links are tiny and hard to tap on a phone' },
  { code: 'slow_load', pts: (c) => (mobile(c).loadMs > 8000 ? 20 : 12), label: (c) => `Slow load (${secs(mobile(c).loadMs)}s on mobile)`,
    when: (c) => (mobile(c)?.loadMs ?? 0) > 5000,
    pitch: (c) => `the homepage takes about ${secs(mobile(c).loadMs)} seconds to load on a phone, and most people leave after 3` },
  { code: 'slow_server', pts: 8, label: (c) => `Slow server response (${secs(c.lite.ttfbMs)}s)`,
    when: (c) => (c.lite.ttfbMs ?? 0) > 2500 && !(mobile(c)?.loadMs > 5000),
    pitch: (c) => `the server takes ${secs(c.lite.ttfbMs)} seconds just to start responding` },
  { code: 'heavy_page', pts: (c) => (mobile(c).transferBytes > 5e6 ? 12 : 6), label: (c) => `Heavy page (${(mobile(c).transferBytes / 1e6).toFixed(1)} MB)`,
    when: (c) => (mobile(c)?.transferBytes ?? 0) > 3e6,
    pitch: (c) => `the homepage downloads ${(mobile(c).transferBytes / 1e6).toFixed(1)} MB, which is painful on a cellular connection` },
  { code: 'psi_poor', pts: (c) => (c.psi.performance < 50 ? 12 : 6), label: (c) => `Google PageSpeed ${c.psi.performance}/100 on mobile`,
    when: (c) => c.psi?.performance != null && c.psi.performance < 70,
    pitch: (c) => `Google's own PageSpeed test scores your site ${c.psi.performance}/100 on mobile` },
  { code: 'old_copyright', pts: (c) => (c.lite.copyrightAge >= 6 ? 14 : 8), label: (c) => `Stale copyright (© ${c.lite.copyrightYear})`,
    when: (c) => (c.lite.copyrightAge ?? 0) >= 3,
    pitch: (c) => `the footer still says © ${c.lite.copyrightYear}, which makes the business look inactive` },
  { code: 'flash', pts: 25, label: 'Uses Flash',
    when: (c) => c.lite.flash, pitch: () => 'parts of the site rely on Flash, which no browser has supported for years' },
  { code: 'frames', pts: 20, label: 'Built with frames',
    when: (c) => c.lite.frames, pitch: () => 'the site is built with HTML frames, a 1990s technique that breaks on phones and hurts search ranking' },
  { code: 'legacy_tags', pts: 12, label: 'Legacy HTML (font/center/marquee)',
    when: (c) => c.lite.legacyTags && !c.lite.flash && !c.lite.frames,
    pitch: () => 'the site is built with outdated HTML that gives it a dated look' },
  { code: 'table_layout', pts: 12, label: 'Table-based layout',
    when: (c) => c.lite.tableLayout, pitch: () => 'the page layout is built from HTML tables, which is a sign of a very old design' },
  { code: 'jquery_old', pts: 8, label: (c) => `Old jQuery ${c.lite.jquery}`,
    when: (c) => c.lite.jqueryOld, pitch: (c) => `the site runs jQuery ${c.lite.jquery}, which has known security issues` },
  { code: 'wp_old', pts: 10, label: 'Outdated WordPress',
    when: (c) => c.lite.wpOld, pitch: () => 'the site is running an outdated version of WordPress, a common way sites get hacked' },
  { code: 'template_builder', pts: 6, label: (c) => `Dated template builder (${c.lite.builder})`,
    when: (c) => ['godaddy', 'weebly', 'yola/other-template'].includes(c.lite.builder),
    pitch: (c) => `the site looks like it's on a ${c.lite.builder} template builder, which limits design and search visibility` },
  { code: 'no_cta', pts: 12, label: 'No click-to-call, form or booking on homepage',
    when: (c) => !c.lite.hasCta && !desktop(c)?.phoneVisible && !c.lite.spaShell,
    pitch: () => 'there\'s no click-to-call button, contact form or booking link on the homepage, so interested customers have nowhere easy to go' },
  { code: 'no_booking', pts: 8, label: 'No online booking/ordering',
    when: (c) => BOOKING_CATEGORIES.has(c.biz.category) && !c.lite.hasBooking,
    pitch: () => 'customers can\'t book or order online' },
  { code: 'bad_title', pts: 7, label: 'Missing or generic page title',
    when: (c) => !c.lite.title || c.lite.title.length <= 3 || /^(home|untitled|welcome|index|new page)\b/i.test(c.lite.title),
    pitch: () => 'the page title in Google results is blank or generic, so you\'re missing free search traffic' },
  { code: 'no_meta', pts: 5, label: 'No meta description',
    when: (c) => !c.lite.metaDescription, pitch: () => 'there\'s no search description set, so Google writes its own' },
  { code: 'no_h1', pts: 3, label: 'No H1 heading',
    when: (c) => c.lite.h1Count === 0 && !c.lite.spaShell, pitch: () => 'the homepage has no main heading, which hurts search ranking' },
  { code: 'no_og', pts: 3, label: 'No social preview tags',
    when: (c) => !c.lite.og, pitch: () => 'links to the site look blank when shared on Facebook or in texts' },
  { code: 'missing_alt', pts: 3, label: 'Images missing alt text',
    when: (c) => c.lite.imgCount >= 5 && c.lite.imgsNoAlt / c.lite.imgCount > 0.6,
    pitch: () => 'most images have no alt text, which hurts accessibility and search' },
  { code: 'broken_images', pts: 6, label: 'Broken images',
    when: (c) => (mobile(c)?.brokenImages ?? 0) > 0, pitch: () => 'some images on the homepage are broken' },
  { code: 'failed_requests', pts: 4, label: 'Broken resources/console errors',
    when: (c) => (mobile(c)?.failedRequests ?? 0) >= 5 || (mobile(c)?.consoleErrors ?? 0) >= 5,
    pitch: () => 'the page has multiple broken resources and script errors' },
  { code: 'mixed_content', pts: 6, label: 'Mixed content (http assets on https page)',
    when: (c) => c.lite.mixedContent, pitch: () => 'the page loads insecure content, which can trigger browser warnings' },
  { code: 'thin_content', pts: 6, label: 'Very little content',
    when: (c) => mobile(c) && mobile(c).bodyTextLength < 300 && !c.lite.spaShell,
    pitch: () => 'the homepage has almost no content, so it gives visitors (and Google) little to go on' },
];

const val = (x, c) => (typeof x === 'function' ? x(c) : x);

function ruleIssues(c) {
  return RULES.filter((r) => { try { return r.when(c); } catch { return false; } })
    .map((r) => ({ code: r.code, pts: val(r.pts, c), label: val(r.label, c), pitch: val(r.pitch, c) }))
    .sort((a, b) => b.pts - a.pts);
}

function oneIssue(code, pts, label, pitch) {
  return [{ code, pts, label, pitch }];
}

/** Returns { status, score, rank, tier, issues, email } for one business. */
export function scoreProspect(biz, lite, deep, psi, enrich = {}) {
  const email = enrich.email || biz.email || lite?.emails?.[0] || '';
  const website = enrich.website || biz.website;
  let status;
  let issues;

  if (enrich.stillOpen === false) {
    status = 'closed';
    issues = [];
  } else if (biz.websiteKind === 'none' && !enrich.website) {
    status = 'no_website';
    issues = oneIssue('no_website', 85, 'No website',
      'your business doesn\'t seem to have a website, so people searching for you can\'t find your hours, services or contact info');
  } else if (biz.websiteKind === 'social' && !enrich.website) {
    status = 'social_only';
    issues = oneIssue('social_only', 75, 'Only a social/directory page',
      'the only web presence I could find for you is a social media or directory page rather than a site of your own');
  } else if (!lite) {
    status = 'unaudited';
    issues = [];
  } else if (!lite.reachable) {
    status = 'site_down';
    issues = oneIssue('site_down', 90, `Website down (${lite.error || `HTTP ${lite.status}`})`,
      'your website wasn\'t loading when I checked');
  } else if (lite.parked) {
    status = 'parked';
    issues = oneIssue('parked', 85, 'Parked/expired/placeholder site',
      'your website shows a parked, expired or placeholder page');
  } else {
    status = deep ? 'audited_deep' : 'audited';
    issues = ruleIssues({ biz, lite, deep, psi });
  }

  const raw = issues.reduce((s, i) => s + i.pts, 0);
  const score = Math.min(100, raw);
  let bonus = 0;
  if (email) bonus += 5;
  if (biz.phone) bonus += 2;
  if (biz.hours) bonus += 2;
  if (HIGH_VALUE_CATEGORIES.has(biz.category)) bonus += 4;
  const rank = score ? score + bonus : 0;
  const tier = score >= 55 ? 'hot' : score >= 30 ? 'warm' : score > 0 ? 'cold' : 'none';
  return { status, score, rank, tier, issues, email, website };
}
