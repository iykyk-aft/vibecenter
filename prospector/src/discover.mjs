import fs from 'node:fs';
import {
  CHAIN_DOMAINS, DENVER_BBOX, NON_BUSINESS_OFFICES, SOCIAL_HOSTS, UA,
} from './config.mjs';
import { hostMatches, hostOf, log, parseCsv, slug, writeJson } from './util.mjs';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const FOOD_AND_SERVICE =
  'restaurant|cafe|bar|pub|fast_food|biergarten|ice_cream|food_court|nightclub|dentist|doctors|clinic|' +
  'veterinary|pharmacy|car_wash|car_rental|car_repair|studio|coworking_space|events_venue|social_facility|' +
  'childcare|music_school|driving_school|language_school|arts_centre|theatre|cinema|spa';

// Denver = city & county (Wikidata Q16554, admin_level 6). Bbox post-filter guards against namesakes.
export const QUERY = `[out:json][timeout:240];
(
  area["boundary"="administrative"]["wikidata"="Q16554"];
  area["boundary"="administrative"]["name"="Denver"]["admin_level"="6"];
)->.a;
(
  nwr(area.a)["name"]["shop"];
  nwr(area.a)["name"]["craft"];
  nwr(area.a)["name"]["office"];
  nwr(area.a)["name"]["healthcare"];
  nwr(area.a)["name"]["amenity"~"^(${FOOD_AND_SERVICE})$"];
  nwr(area.a)["name"]["leisure"~"^(fitness_centre|yoga|dance|sports_centre|bowling_alley|escape_game)$"];
  nwr(area.a)["name"]["tourism"~"^(hotel|motel|guest_house|hostel|gallery|apartment)$"];
);
out center tags;`;

export async function fetchOverpass(query = QUERY) {
  let lastErr;
  for (const url of MIRRORS) {
    try {
      log(`overpass: ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('no elements in response');
      return json.elements;
    } catch (e) {
      lastErr = e;
      log(`  failed: ${e.cause?.code || e.message}`);
    }
  }
  throw new Error(`all Overpass mirrors failed (${lastErr?.cause?.code || lastErr?.message}). Is outbound network open?`);
}

export function classifyWebsite(raw) {
  const value = String(raw || '').trim().split(/[;\s]/)[0];
  if (!value) return { kind: 'none', url: '' };
  const host = hostOf(value);
  if (!host || !host.includes('.')) return { kind: 'none', url: '' };
  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return { kind: hostMatches(host, SOCIAL_HOSTS) ? 'social' : 'site', url };
}

const CATEGORY_KEYS = ['shop', 'amenity', 'craft', 'office', 'healthcare', 'tourism', 'leisure'];

export function toBusiness(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const key = CATEGORY_KEYS.find((k) => t[k]);
  const site = classifyWebsite(t.website || t['contact:website'] || t.url || t['contact:url']);
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    id: `${el.type}-${el.id}`,
    source: 'osm',
    name: t.name,
    category: key ? t[key] : 'other',
    categoryKey: key || 'other',
    address: [street, t['addr:unit'], t['addr:postcode']].filter(Boolean).join(', '),
    lat,
    lon,
    phone: t.phone || t['contact:phone'] || '',
    email: (t.email || t['contact:email'] || '').split(';')[0].trim(),
    websiteKind: site.kind,
    website: site.url,
    facebook: t['contact:facebook'] || '',
    hours: t.opening_hours || '',
    brand: t.brand || t['brand:wikidata'] || t['operator:wikidata'] || '',
    office: t.office || '',
  };
}

export function inDenver(b) {
  return b.lat != null && b.lat >= DENVER_BBOX.south && b.lat <= DENVER_BBOX.north &&
    b.lon >= DENVER_BBOX.west && b.lon <= DENVER_BBOX.east;
}

/** Drop chains, franchises, institutions and non-business offices. Returns {kept, dropped}. */
export function filterSmallBusinesses(list) {
  const nameCount = new Map();
  for (const b of list) nameCount.set(b.name.toLowerCase(), (nameCount.get(b.name.toLowerCase()) || 0) + 1);
  const kept = [];
  const dropped = [];
  for (const b of list) {
    let why = '';
    if (b.brand) why = 'brand tag';
    else if (nameCount.get(b.name.toLowerCase()) >= 3) why = 'name repeats 3+ times (likely chain)';
    else if (b.websiteKind === 'site' && hostMatches(hostOf(b.website), CHAIN_DOMAINS)) why = 'chain domain';
    else if (b.office && NON_BUSINESS_OFFICES.has(b.office)) why = `office=${b.office}`;
    (why ? dropped : kept).push(why ? { ...b, dropReason: why } : b);
  }
  return { kept, dropped };
}

/** Businesses found by hand or by web search: CSV (name,website,address,phone,email,category) or JSON array. */
export function loadManual(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = file.endsWith('.json') ? JSON.parse(text) : parseCsv(text);
  return rows.filter((r) => r.name).map((r) => {
    const site = classifyWebsite(r.website);
    return {
      id: `m-${slug(r.name)}-${slug(r.address || r.phone || '')}`,
      source: 'manual',
      name: r.name,
      category: r.category || 'other',
      categoryKey: 'manual',
      address: r.address || '',
      phone: r.phone || '',
      email: r.email || '',
      websiteKind: site.kind,
      website: site.url,
      facebook: '',
      hours: '',
      brand: '',
      office: '',
    };
  });
}

export async function discover({ manualFiles = [], elements } = {}) {
  const els = elements || (await fetchOverpass());
  const osm = els.filter((e) => e.tags?.name).map(toBusiness).filter(inDenver);
  const { kept, dropped } = filterSmallBusinesses(osm);
  const manual = manualFiles.flatMap(loadManual);
  const seen = new Set(kept.map((b) => b.id));
  const all = [...kept, ...manual.filter((m) => !seen.has(m.id))];
  const stats = {
    osmRaw: osm.length,
    chainsDropped: dropped.length,
    manual: manual.length,
    total: all.length,
    withSite: all.filter((b) => b.websiteKind === 'site').length,
    socialOnly: all.filter((b) => b.websiteKind === 'social').length,
    noWebsite: all.filter((b) => b.websiteKind === 'none').length,
  };
  writeJson('businesses.json', all);
  writeJson('dropped.json', dropped);
  return stats;
}
