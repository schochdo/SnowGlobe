#!/usr/bin/env node
/**
 * enrich_global_infobox_stats.cjs
 *
 * 1. Enumerates ALL English Wikipedia articles transcluding Template:Infobox ski area
 *    via MediaWiki API `list=embeddedin` (captures resorts typed as mountains on Wikidata
 *    such as Mount Snow, Gore Mountain, Cannon Mountain, Snow King, plus international resorts).
 * 2. Fetches section 0 wikitext + primary coordinates + wikibase_item in batches of 50.
 * 3. Backfills missing coordinates from Wikidata P625 in batches of 50.
 * 4. Parses authentic `skiable_area`/`area` (non-European, non-Japan downhill),
 *    `snowfall`/`annual_snowfall` (worldwide downhill), and `runs_length`/`piste_length`
 *    (fallback when geometry trail_km is absent).
 * 5. Never overwrites existing verified skiable_acres or avg_snowfall_in values.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const USER_AGENT = 'SnowGlobe/1.0 (https://github.com/schochdo/SnowGlobe)';

const EUROPEAN_COUNTRIES = new Set([
  'France', 'Switzerland', 'Austria', 'Italy', 'Germany', 'Andorra', 'Spain',
  'Norway', 'Sweden', 'Finland', 'Slovenia', 'Slovakia', 'Poland', 'Czech Republic',
  'Bulgaria', 'Romania', 'Greece', 'Georgia', 'Turkey', 'Bosnia and Herzegovina',
  'Serbia', 'Montenegro', 'North Macedonia', 'Ukraine',
]);

const STOP_WORDS = new Set([
  'ski', 'area', 'resort', 'mountain', 'mt', 'mount', 'park', 'valley', 'pass',
  'peak', 'bowl', 'lodge', 'village', 'center', 'centre', 'alpine', 'winter',
  'sports', 'club', 'hill', 'hills', 'the', 'of', 'and', 'de', 'du', 'la', 'le', 'les',
]);

function getTokens(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371.0;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cleanWikiValue(raw) {
  if (!raw) return '';
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<ref[^/]*\/>/gi, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&ndash;|&#8211;|–|—/g, '-')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseInfoboxField(wikitext, fieldNames) {
  for (const fieldName of fieldNames) {
    const re = new RegExp(`^\\s*\\|\\s*${fieldName}\\s*=\\s*(.+)$`, 'im');
    const m = re.exec(wikitext);
    if (m && m[1].trim()) {
      const cleaned = cleanWikiValue(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function parseAcres(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const validate = (ac) => {
    if (!isFinite(ac) || ac < 10 || ac > 12000) return null;
    if (ac > 6000 && (lower.includes('total') || lower.includes('permit')) && !lower.includes('skiable')) {
      return null;
    }
    return Math.round(ac);
  };

  // {{convert|1,234|acre|...}} or {{cvt|500|ha|...}}
  let m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(acres?|ha|hectares?|km2|sqkm)\b/i.exec(raw);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    const unit = m[2].toLowerCase();
    if (unit.startsWith('h')) return validate(val * 2.47105);
    if (unit.startsWith('k') || unit.startsWith('sq')) return validate(val * 247.105);
    return validate(val);
  }

  // Plain "1,234 acres" or "1,234 ac"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:skiable\s+)?(?:acres?|ac\b)/i.exec(raw);
  if (m) return validate(parseFloat(m[1].replace(/,/g, '')));

  // Plain "500 ha" or "500 hectares"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:ha\b|hectares?)/i.exec(raw);
  if (m) return validate(parseFloat(m[1].replace(/,/g, '')) * 2.47105);

  return null;
}

function parseSnowfallIn(raw) {
  if (!raw) return null;

  const toInches = (val, unit) => {
    const u = unit.toLowerCase();
    if (u === 'cm') return val / 2.54;
    if (u === 'ft' || u === 'feet' || u === 'foot') return val * 12;
    if (u === 'm' || u === 'meter' || u === 'meters' || u === 'metre' || u === 'metres') return val * 39.3701;
    return val;
  };
  const validate = (inches) => {
    const r = Math.round(inches);
    return r >= 20 && r <= 900 ? r : null;
  };

  // Range in convert template: {{convert|250|-|300|in|cm}} or {{convert|250|to|300|in|cm}}
  let m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(?:-|to|and)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(in|inch|inches|cm|ft|feet|m)\b/i.exec(raw);
  if (m) {
    const lo = parseFloat(m[1].replace(/,/g, ''));
    const hi = parseFloat(m[2].replace(/,/g, ''));
    return validate(toInches((lo + hi) / 2, m[3]));
  }

  // Single convert template: {{convert|350|in|...}}
  m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(in|inch|inches|cm|ft|feet|m)\b/i.exec(raw);
  if (m) {
    return validate(toInches(parseFloat(m[1].replace(/,/g, '')), m[2]));
  }

  // Plain range: "250-300 in", "250-300 inches", "250-300\"", "600-800 cm"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9,]+(?:\.[0-9]+)?)\s*(in\b|inches|"|cm\b|ft\b|feet\b|m\b)/i.exec(raw);
  if (m) {
    const lo = parseFloat(m[1].replace(/,/g, ''));
    const hi = parseFloat(m[2].replace(/,/g, ''));
    const u = m[3] === '"' ? 'in' : m[3];
    return validate(toInches((lo + hi) / 2, u));
  }

  // Plain single: "350 in", "350 inches", "350\"", "800 cm", "30 ft", "8 m"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(in\b|inches|"|cm\b|ft\b|feet\b|m\b)/i.exec(raw);
  if (m) {
    const u = m[2] === '"' ? 'in' : m[2];
    return validate(toInches(parseFloat(m[1].replace(/,/g, '')), u));
  }

  return null;
}

function parseTrailKm(raw) {
  if (!raw) return null;
  const validate = (km) => (isFinite(km) && km >= 0.5 && km <= 700 ? Math.round(km * 10) / 10 : null);

  let m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(km|mi|miles?)\b/i.exec(raw);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    const u = m[2].toLowerCase();
    return validate(u.startsWith('m') ? val * 1.60934 : val);
  }
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(km\b|kilometers?|kilometres?|mi\b|miles?)/i.exec(raw);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    const u = m[2].toLowerCase();
    return validate(u.startsWith('m') ? val * 1.60934 : val);
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  console.log('1. Enumerating all Wikipedia articles using Template:Infobox ski area...');
  const titles = [];
  let eicontinue = '';
  while (true) {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&list=embeddedin&eititle=Template:Infobox_ski_area&einamespace=0&eilimit=500&format=json' +
      (eicontinue ? `&eicontinue=${encodeURIComponent(eicontinue)}` : '');
    const data = await fetchJson(url);
    for (const item of data?.query?.embeddedin || []) {
      if (item.title) titles.push(item.title);
    }
    eicontinue = data?.continue?.eicontinue || '';
    if (!eicontinue) break;
  }
  console.log(`Found ${titles.length} Wikipedia articles with {{Infobox ski area}}.`);

  const entries = [];
  const needWikidataCoord = [];
  const BATCH = 50;

  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&prop=revisions|coordinates|pageprops&rvprop=content&rvsection=0&rvslots=main&coprimary=primary&ppprop=wikibase_item&redirects=1&format=json&titles=' +
      encodeURIComponent(batch.join('|'));
    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.warn(`Batch ${i} failed:`, err.message);
      continue;
    }

    for (const page of Object.values(data?.query?.pages || {})) {
      const content = page?.revisions?.[0]?.slots?.main?.['*'] || '';
      if (!content) continue;

      const acres = parseAcres(parseInfoboxField(content, ['skiable_area', 'area']));
      const snowfallIn = parseSnowfallIn(parseInfoboxField(content, ['snowfall', 'annual_snowfall', 'average_snowfall']));
      const trailKm = parseTrailKm(parseInfoboxField(content, ['runs_length', 'piste_length', 'total_length']));

      if (!acres && !snowfallIn && !trailKm) continue;

      const coord = page?.coordinates?.[0];
      const qid = page?.pageprops?.wikibase_item || null;
      const entry = {
        title: page.title,
        tokens: getTokens(page.title),
        lat: coord?.lat ?? null,
        lng: coord?.lon ?? null,
        qid,
        acres,
        snowfallIn,
        trailKm,
      };
      entries.push(entry);
      if ((entry.lat == null || entry.lng == null) && qid) {
        needWikidataCoord.push(entry);
      }
    }
  }

  console.log(`Parsed ${entries.length} infoboxes with usable stats (${needWikidataCoord.length} need Wikidata P625 coords).`);

  // Backfill missing coordinates from Wikidata P625
  for (let i = 0; i < needWikidataCoord.length; i += BATCH) {
    const batch = needWikidataCoord.slice(i, i + BATCH);
    const ids = batch.map((e) => e.qid).join('|');
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=claims&format=json`;
    try {
      const data = await fetchJson(url);
      for (const e of batch) {
        const claim = data?.entities?.[e.qid]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
        if (claim && typeof claim.latitude === 'number' && typeof claim.longitude === 'number') {
          e.lat = claim.latitude;
          e.lng = claim.longitude;
        }
      }
    } catch (err) {
      console.warn(`Wikidata coord batch ${i} failed:`, err.message);
    }
  }

  const geoEntries = entries.filter((e) => typeof e.lat === 'number' && typeof e.lng === 'number');
  console.log(`Geolocated infobox entries ready for matching: ${geoEntries.length}`);

  const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  let enrichedAcres = 0;
  let enrichedSnow = 0;
  let enrichedTrailKm = 0;

  for (const f of fc.features) {
    const p = f.properties;
    if (!p || p.category !== 'downhill') continue;
    const [lng, lat] = f.geometry.coordinates;
    const pTokens = getTokens(p.name);

    let best = null;
    let bestScore = -Infinity;
    for (const w of geoEntries) {
      const d = haversineKm(lng, lat, w.lng, w.lat);
      if (d > 8.0) continue;
      const overlap = pTokens.filter((t) => w.tokens.includes(t)).length;
      if (overlap === 0 && d > 1.5) continue;
      const score = overlap * 10 - d;
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
    }

    if (!best) continue;

    const allowAcres = !EUROPEAN_COUNTRIES.has(String(p.country || '').trim()) && p.country !== 'Japan';
    if (allowAcres && (!p.skiable_acres || p.skiable_acres === 0) && best.acres) {
      p.skiable_acres = best.acres;
      enrichedAcres++;
    }
    if (p.avg_snowfall_in == null && best.snowfallIn) {
      p.avg_snowfall_in = best.snowfallIn;
      enrichedSnow++;
    }
    if ((!p.trail_km || p.trail_km === 0) && best.trailKm) {
      p.trail_km = best.trailKm;
      p.trail_mi = Math.round(best.trailKm * 0.621371 * 10) / 10;
      enrichedTrailKm++;
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
  console.log(
    `Enriched global_ski_areas.json: +${enrichedAcres} skiable_acres, +${enrichedSnow} avg_snowfall_in, +${enrichedTrailKm} fallback trail_km.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
