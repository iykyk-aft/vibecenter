import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Everything the tool writes (business lists, contact emails, screenshots, drafts)
// lives here. It is gitignored: the repo's Stop hook auto-commits and pushes.
// Resolved on every call (not at import) so tests can redirect it to a temp dir.
export const outDir = () => process.env.PROSPECTOR_OUT || path.join(ROOT, 'out');

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 DenverSiteAudit/1.0';

// Denver city/county bounding box, used to drop any stray Overpass matches.
export const DENVER_BBOX = { south: 39.614, north: 39.915, west: -105.113, east: -104.597 };

// A listed "website" on one of these is not a real website — itself a lead.
export const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'yelp.com', 'linktr.ee', 'linkin.bio', 'twitter.com',
  'x.com', 'tiktok.com', 'youtube.com', 'tripadvisor.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
  'yellowpages.com', 'mapquest.com', 'foursquare.com', 'nextdoor.com', 'beacons.ai', 'carrd.co',
];

// Chains / franchises / big institutions: not the target market.
export const CHAIN_DOMAINS = [
  'starbucks.com', 'mcdonalds.com', 'subway.com', 'walmart.com', 'target.com', 'kingsoopers.com', 'safeway.com',
  'walgreens.com', 'cvs.com', '7-eleven.com', 'chipotle.com', 'dunkindonuts.com', 'dunkin.com', 'wendys.com',
  'burgerking.com', 'tacobell.com', 'kfc.com', 'pizzahut.com', 'dominos.com', 'papajohns.com', 'panerabread.com',
  'chick-fil-a.com', 'sonicdrivein.com', 'jimmyjohns.com', 'pandaexpress.com',
  'homedepot.com', 'lowes.com', 'bestbuy.com', 'costco.com', 'samsclub.com', 'wholefoodsmarket.com', 'traderjoes.com', 'sprouts.com', 'albertsons.com', 'amazon.com', 'ulta.com',
  'sephora.com', 'supercuts.com', 'greatclips.com', 'sportsclips.com', 'planetfitness.com', 'orangetheory.com',
  'anytimefitness.com', 'lifetime.life', 'snapfitness.com', 'f45training.com', 'bankofamerica.com',
  'wellsfargo.com', 'chase.com', 'usbank.com', 'fidelity.com', 'allstate.com', 'statefarm.com', 'geico.com',
  'verizon.com', 'att.com', 't-mobile.com', 'ups.com', 'fedex.com', 'usps.com', 'autozone.com', 'oreillyauto.com',
  'jiffylube.com', 'valvoline.com', 'discounttire.com', 'firestonecompleteautocare.com', 'hertz.com',
  'enterprise.com', 'avis.com', 'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com', 'choicehotels.com',
  'bestwestern.com', 'wyndhamhotels.com', 'dickssportinggoods.com', 'rei.com', 'petco.com', 'petsmart.com',
  'michaels.com', 'joann.com', 'dollartree.com', 'dollargeneral.com', 'familydollar.com', 'ross.com', 'tjmaxx.com',
  'marshalls.com', 'nordstrom.com', 'macys.com', 'kohls.com', 'jcpenney.com', 'gap.com', 'oldnavy.com', 'hm.com',
  'uchealth.org', 'centura.org', 'hcacolorado.com', 'denverhealth.org', 'childrenscolorado.org',
];

// OSM `office=*` values that are not small-business prospects.
export const NON_BUSINESS_OFFICES = new Set([
  'government', 'ngo', 'association', 'educational_institution', 'diplomatic', 'religion', 'political_party',
  'foundation', 'union', 'quango', 'research', 'administrative',
]);

// Categories where a missing online-booking/ordering flow is a real gap.
export const BOOKING_CATEGORIES = new Set([
  'restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'bakery', 'dentist', 'doctors', 'clinic', 'veterinary',
  'hairdresser', 'beauty', 'massage', 'tattoo', 'fitness_centre', 'yoga', 'dance', 'hotel', 'guest_house',
  'car_repair', 'car_wash', 'spa',
]);

// Higher-ticket services: a better website is worth more to them, so rank them up a little.
export const HIGH_VALUE_CATEGORIES = new Set([
  'dentist', 'doctors', 'clinic', 'veterinary', 'lawyer', 'accountant', 'estate_agent', 'insurance',
  'financial', 'architect', 'construction', 'plumber', 'electrician', 'hvac', 'roofer', 'car_repair',
  'physiotherapist', 'chiropractor', 'hotel', 'jewelry', 'furniture', 'interior_design', 'photographer',
  'event_venue', 'wedding', 'landscaper', 'cleaning', 'moving', 'it', 'company',
]);
