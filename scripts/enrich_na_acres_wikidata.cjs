#!/usr/bin/env node
/**
 * enrich_na_acres_wikidata.cjs
 *
 * 1. Queries Wikidata SPARQL (CC0) for all US & Canada ski resorts (Q130003)
 *    with coordinates (P625) and English Wikipedia sitelinks.
 * 2. Fetches section 0 (Infobox ski area) from the official English Wikipedia
 *    MediaWiki API in batches of 50 titles.
 * 3. Parses structured `skiable_area` (acres) and `snowfall` (inches/yr) from
 *    Infobox templates and enriches matching US/Canada downhill resorts in
 *    public/data/global_ski_areas.json (preserving already-verified official specs).
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');

const SPARQL_QUERY = `
SELECT ?item ?itemLabel ?coord ?article WHERE {
  ?item wdt:P31/wdt:P279* wd:Q130003 .
  VALUES ?country { wd:Q30 wd:Q16 }
  ?item wdt:P17 ?country .
  ?item wdt:P625 ?coord .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

const STOP_WORDS = new Set([
  'ski', 'area', 'resort', 'mountain', 'mt', 'mount', 'park', 'valley', 'pass',
  'peak', 'bowl', 'lodge', 'village', 'center', 'centre', 'alpine', 'winter',
  'sports', 'club', 'hill', 'hills', 'the', 'of', 'and',
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

function parseWktPoint(wkt) {
  const m = /Point\(([0-9.-]+)\s+([0-9.-]+)\)/i.exec(wkt || '');
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

function parseInfoboxField(wikitext, fieldName) {
  const re = new RegExp(`^\\s*\\|\\s*${fieldName}\\s*=\\s*(.+)$`, 'im');
  const m = re.exec(wikitext);
  return m ? m[1].trim() : null;
}

function parseAcres(raw) {
  if (!raw) return null;
  // {{convert|1,234|acre|...}} or {{cvt|1234|acre|...}}
  let m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(acres?|ha|hectares?)/i.exec(raw);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    const unit = m[2].toLowerCase();
    const ac = unit.startsWith('h') ? Math.round(val * 2.47105) : Math.round(val);
    return ac >= 10 && ac <= 10000 ? ac : null;
  }
  // Plain "1,234 acres" or "1,234 ac"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:skiable\s+)?(?:acres?|ac\b)/i.exec(raw);
  if (m) {
    const ac = Math.round(parseFloat(m[1].replace(/,/g, '')));
    return ac >= 10 && ac <= 10000 ? ac : null;
  }
  // Plain "500 ha" or "500 hectares"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:ha\b|hectares?)/i.exec(raw);
  if (m) {
    const ac = Math.round(parseFloat(m[1].replace(/,/g, '')) * 2.47105);
    return ac >= 10 && ac <= 10000 ? ac : null;
  }
  return null;
}

function parseSnowfallIn(raw) {
  if (!raw) return null;
  // {{convert|350|in|...}} or {{convert|800|cm|...}} or {{convert|30|ft|...}}
  let m = /\{\{(?:convert|cvt)\s*\|\s*([0-9,]+(?:\.[0-9]+)?)\s*\|\s*(in|inch|inches|cm|ft|feet|m)\b/i.exec(raw);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    const unit = m[2].toLowerCase();
    let inches = val;
    if (unit === 'cm') inches = val / 2.54;
    else if (unit === 'ft' || unit === 'feet') inches = val * 12;
    else if (unit === 'm') inches = val * 39.3701;
    inches = Math.round(inches);
    return inches >= 20 && inches <= 850 ? inches : null;
  }
  // Plain "350 in" or "350 inches" or 350"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*(?:in\b|inches|")/i.exec(raw);
  if (m) {
    const inches = Math.round(parseFloat(m[1].replace(/,/g, '')));
    return inches >= 20 && inches <= 850 ? inches : null;
  }
  // Plain "800 cm"
  m = /([0-9,]+(?:\.[0-9]+)?)\s*cm\b/i.exec(raw);
  if (m) {
    const inches = Math.round(parseFloat(m[1].replace(/,/g, '')) / 2.54);
    return inches >= 20 && inches <= 850 ? inches : null;
  }
  return null;
}

async function main() {
  const sparqlUrl =
    'https://query.wikidata.org/sparql?format=json&query=' +
    encodeURIComponent(SPARQL_QUERY);

  console.log('1. Querying Wikidata SPARQL for US/Canada ski resorts with Wikipedia articles...');
  const res = await fetch(sparqlUrl, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'SnowGlobe/1.0 (https://github.com/schochdo/SnowGlobe)',
    },
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL failed: HTTP ${res.status}`);

  const json = await res.json();
  const bindings = json?.results?.bindings || [];

  const wikiByTitle = new Map();
  for (const b of bindings) {
    const articleUrl = b.article?.value || '';
    const titleMatch = /\/wiki\/(.+)$/.exec(articleUrl);
    const pt = parseWktPoint(b.coord?.value);
    if (!titleMatch || !pt) continue;
    const title = decodeURIComponent(titleMatch[1]).replace(/_/g, ' ');
    if (!wikiByTitle.has(title)) {
      wikiByTitle.set(title, {
        title,
        label: b.itemLabel?.value || title,
        tokens: getTokens(b.itemLabel?.value || title),
        lng: pt[0],
        lat: pt[1],
        acres: null,
        snowfall_in: null,
      });
    }
  }

  const allTitles = Array.from(wikiByTitle.keys());
  console.log(`Found ${allTitles.length} unique Wikipedia ski resort articles. Fetching infoboxes...`);

  const BATCH = 50;
  let parsedAcresCount = 0;
  let parsedSnowCount = 0;

  for (let i = 0; i < allTitles.length; i += BATCH) {
    const batch = allTitles.slice(i, i + BATCH);
    const wpUrl =
      'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvsection=0&rvslots=main&format=json&redirects=1&titles=' +
      encodeURIComponent(batch.join('|'));

    const wpRes = await fetch(wpUrl, {
      headers: { 'User-Agent': 'SnowGlobe/1.0 (https://github.com/schochdo/SnowGlobe)' },
    });
    if (!wpRes.ok) continue;
    const wpJson = await wpRes.json();

    // Map redirected titles back to original requested title
    const redirectMap = new Map();
    for (const r of wpJson?.query?.redirects || []) {
      redirectMap.set(r.to, r.from);
    }

    const pages = wpJson?.query?.pages || {};
    for (const page of Object.values(pages)) {
      const content = page?.revisions?.[0]?.slots?.main?.['*'] || '';
      if (!content) continue;

      const origTitle = redirectMap.get(page.title) || page.title;
      const entry = wikiByTitle.get(origTitle) || wikiByTitle.get(page.title);
      if (!entry) continue;

      const acres = parseAcres(parseInfoboxField(content, 'skiable_area'));
      const snow = parseSnowfallIn(parseInfoboxField(content, 'snowfall'));
      if (acres) {
        entry.acres = acres;
        parsedAcresCount++;
      }
      if (snow) {
        entry.snowfall_in = snow;
        parsedSnowCount++;
      }
    }
  }

  console.log(`Parsed from Wikipedia infoboxes: acres=${parsedAcresCount}, snowfall=${parsedSnowCount}`);

  const wikiList = Array.from(wikiByTitle.values()).filter((w) => w.acres || w.snowfall_in);
  const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  let enrichedAcres = 0;
  let enrichedSnow = 0;

  for (const f of fc.features) {
    const p = f.properties;
    if (!p || p.category !== 'downhill') continue;
    if (p.country !== 'United States' && p.country !== 'Canada') continue;

    const [lng, lat] = f.geometry.coordinates;
    const pTokens = getTokens(p.name);

    let best = null;
    let bestScore = -Infinity;

    for (const w of wikiList) {
      const d = haversineKm(lng, lat, w.lng, w.lat);
      if (d > 10) continue;
      const overlap = pTokens.filter((t) => w.tokens.includes(t)).length;
      if (overlap === 0 && d > 2.5) continue;

      const score = overlap * 10 - d;
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
    }

    if (best) {
      if ((!p.skiable_acres || p.skiable_acres === 0) && best.acres) {
        p.skiable_acres = best.acres;
        enrichedAcres++;
      }
      if (p.avg_snowfall_in == null && best.snowfall_in) {
        p.avg_snowfall_in = best.snowfall_in;
        enrichedSnow++;
      }
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
  console.log(`Enriched global_ski_areas.json from Wikipedia: skiable_acres=${enrichedAcres}, avg_snowfall_in=${enrichedSnow}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
