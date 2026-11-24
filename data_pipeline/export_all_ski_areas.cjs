const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, 'trails.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);

const globalAreasPath = path.join(__dirname, '../public/data/global_ski_areas.json');
const globalAreas = JSON.parse(fs.readFileSync(globalAreasPath, 'utf8')).features;

const resortsText = fs.readFileSync(path.join(__dirname, '../src/data/resorts.ts'), 'utf8');
const atlasResorts = [];
const itemRegex = /{\s*id:\s*['"]([^'"]+)['"][\s\S]*?name:\s*['"]([^'"]+)['"][\s\S]*?lat:\s*([0-9.-]+)[\s\S]*?lng:\s*([0-9.-]+)/g;
let m;
while ((m = itemRegex.exec(resortsText)) !== null) {
  atlasResorts.push({ id: m[1], name: m[2], lat: parseFloat(m[3]), lng: parseFloat(m[4]) });
}

function dist(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const idStmt = db.prepare(`
  SELECT t.geojson FROM trails t
  JOIN resort_trails rt ON t.id = rt.trail_id
  WHERE rt.resort_id = ?
`);

const bboxStmt = db.prepare(`
  SELECT geojson FROM trails
  WHERE min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?
  LIMIT 3000
`);

const { classifySkiAreaTopology } = require('./pisteTopologyGraph.cjs');

const outDir = path.join(__dirname, '../public/data/trails');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function filterTrails(rows) {
  const features = [];
  const seenIds = new Set();

  for (const row of rows) {
    const f = typeof row === 'string' ? JSON.parse(row) : JSON.parse(row.geojson);
    const p = f.properties;
    if (!p) continue;

    // Filter out abandoned/proposed lifts
    if (p.kind === 'lift') {
      if (p.status && p.status !== 'operating') continue;
      const n = (p.name || '').toLowerCase();
      if (n.includes('proposed') || n.includes('planned') || n.includes('abandoned') || n.includes('disused') || n.includes('in project')) {
        continue;
      }
    } else if (p.kind === 'piste') {
      const ptype = p['piste:type'];
      if (ptype && ['fatbike', 'hike', 'sled', 'sleigh', 'ice_skate', 'playground', 'other'].includes(ptype)) {
        continue;
      }
    }

    const fid = String(p.id ?? f.id ?? '');
    if (fid && seenIds.has(fid)) continue;
    if (fid) seenIds.add(fid);

    if (!p.id && fid) p.id = fid;
    delete f.id;
    features.push(f);
  }

  // Run 3-Tier Topological Graph Classifier across pistes and lifts
  const lifts = features.filter(f => f.properties?.kind === 'lift');
  const pistes = features.filter(f => f.properties?.kind === 'piste');
  classifySkiAreaTopology(pistes, lifts);

  // Strip out any feature where properties.atlas_category === 'ignore'
  const validFeatures = features.filter(f => {
    if (f.properties?.kind === 'piste') {
      return f.properties.atlas_category !== 'ignore';
    }
    return true;
  });

  return validFeatures;
}

console.log(`Starting systematic trail export for all ski areas...`);
console.time('total_export');

const manifest = {};
const exportedSet = new Set();
let exportedCount = 0;

const STOP_WORDS = new Set([
  'ski', 'area', 'resort', 'mountain', 'mt', 'mount', 'park', 'valley', 'pass',
  'peak', 'bowl', 'lodge', 'village', 'center', 'centre', 'alpine', 'winter',
  'sports', 'club', 'hill', 'hills', 'the', 'of', 'de', 'du', 'la', 'le', 'les', 'and',
]);

function getSignificantTokens(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function computeLiftEnvelope(rows, fallbackLng, fallbackLat, fallbackDLng, fallbackDLat) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let liftCount = 0;

  for (const row of rows) {
    const f = typeof row === 'string' ? JSON.parse(row) : JSON.parse(row.geojson);
    if (f.properties?.kind !== 'lift') continue;
    if (f.properties?.status && f.properties.status !== 'operating') continue;
    const coords = f.geometry?.type === 'LineString'
      ? f.geometry.coordinates
      : f.geometry?.type === 'MultiLineString'
        ? f.geometry.coordinates.flat()
        : [];
    for (const c of coords) {
      if (Array.isArray(c) && c.length >= 2) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }
    }
    liftCount++;
  }

  if (liftCount === 0 || !isFinite(minLng)) {
    return {
      minLng: fallbackLng - fallbackDLng,
      maxLng: fallbackLng + fallbackDLng,
      minLat: fallbackLat - fallbackDLat,
      maxLat: fallbackLat + fallbackDLat,
    };
  }

  const MARGIN = 0.025; // ~2.5 km margin around outer lifts
  return {
    minLng: Math.min(minLng, fallbackLng) - MARGIN,
    maxLng: Math.max(maxLng, fallbackLng) + MARGIN,
    minLat: Math.min(minLat, fallbackLat) - MARGIN,
    maxLat: Math.max(maxLat, fallbackLat) + MARGIN,
  };
}

// 1. Export Curated Flagship Resorts first
console.log(`Exporting ${atlasResorts.length} curated flagship resorts...`);
for (const r of atlasResorts) {
  const rTokens = getSignificantTokens(r.name);
  // Find matching global ski areas within 25km
  const candidates = [];
  for (const g of globalAreas) {
    const [gLng, gLat] = g.geometry.coordinates;
    const d = dist(r.lat, r.lng, gLat, gLng);
    if (d < 25) {
      const gTokens = getSignificantTokens(g.properties?.name);
      const overlap = rTokens.filter((t) => gTokens.includes(t)).length;
      const isDownhill = g.properties?.category === 'downhill' ? 1 : 0;
      const score = overlap * 10 + isDownhill * 3 - d;
      candidates.push({ feat: g, dist: d, overlap, isDownhill, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Pick primary match only if it has token overlap OR is very close (< 3km) downhill
  const validCandidates = candidates.filter((c) => c.overlap > 0 || (c.isDownhill && c.dist < 3));
  const chosenArea = validCandidates[0]?.feat || null;
  const hexId = chosenArea?.properties?.id;

  // Multi-area aggregation: include all downhill relations within 12km that share primary tokens
  const matchedAreas = validCandidates.filter((c) => c.overlap > 0 && c.isDownhill && c.dist <= 12);
  const matchedHexIds = new Set(matchedAreas.map((c) => c.feat.properties.id).filter(Boolean));
  if (hexId) matchedHexIds.add(hexId);

  // Pass 1: Gather relation rows + seed box around resort coordinates
  const relRows = [];
  for (const hid of matchedHexIds) {
    relRows.push(...idStmt.all(hid));
  }
  const seedRows = bboxStmt.all(r.lng + 0.065, r.lng - 0.065, r.lat + 0.05, r.lat - 0.05);

  // Pass 2: Adaptive envelope around all operating lifts (+0.025 deg margin)
  const env = computeLiftEnvelope([...relRows, ...seedRows], r.lng, r.lat, 0.065, 0.05);
  const spatialRows = bboxStmt.all(env.maxLng, env.minLng, env.maxLat, env.minLat);
  const rawRows = [...spatialRows, ...relRows];

  const features = filterTrails(rawRows);
  if (features.length > 0) {
    const pisteCount = features.filter(f => f.properties?.kind === 'piste').length;
    const polyCount = features.filter(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon').length;
    const liftCount = features.filter(f => f.properties?.kind === 'lift').length;

    const fc = {
      type: 'FeatureCollection',
      properties: {
        atlas_id: r.id,
        name: r.name,
        matched_area_id: hexId,
        matched_area_name: chosenArea?.properties?.name,
        feature_count: features.length,
        pistes: pisteCount,
        polygons: polyCount,
        lifts: liftCount,
      },
      features,
    };

    const jsonStr = JSON.stringify(fc);
    fs.writeFileSync(path.join(outDir, `${r.id}.json`), jsonStr);
    exportedSet.add(r.id);

    if (hexId) {
      fs.writeFileSync(path.join(outDir, `${hexId}.json`), jsonStr);
      manifest[r.id] = hexId;
      manifest[hexId] = r.id;
      exportedSet.add(hexId);
    }
    exportedCount++;
  }
}
console.log(`Exported ${exportedCount} curated flagship resorts.`);

// 2. Export All Global Ski Areas Worldwide
console.log(`Scanning and exporting all ${globalAreas.length} global ski areas...`);
let globalExported = 0;

for (const a of globalAreas) {
  const p = a.properties;
  if (!p || !p.id) continue;
  if (
    p.status === 'abandoned' ||
    p.status === 'closed' ||
    p.status === 'disused' ||
    p.status === 'defunct' ||
    p.status === 'historic' ||
    p.is_closed === true ||
    (p.archetype && (p.archetype.includes('Defunct') || p.archetype.includes('Lost Ski Area') || p.archetype.includes('Historic'))) ||
    (p.infrastructure && (p.infrastructure.toLowerCase().includes('defunct') || p.infrastructure.toLowerCase().includes('abandoned') || p.infrastructure.toLowerCase().includes('historic')))
  ) continue;
  const id = p.id;

  // Skip if already exported
  if (exportedSet.has(id)) continue;

  const [lng, lat] = a.geometry.coordinates;
  // Pass 1: Relation rows + initial seed box
  const relRows = id ? idStmt.all(id) : [];
  const seedRows = bboxStmt.all(lng + 0.045, lng - 0.045, lat + 0.035, lat - 0.035);
  // Pass 2: Adaptive envelope around all operating lifts (+0.025 deg margin)
  const env = computeLiftEnvelope([...relRows, ...seedRows], lng, lat, 0.045, 0.035);
  const spatialRows = bboxStmt.all(env.maxLng, env.minLng, env.maxLat, env.minLat);
  const rows = [...spatialRows, ...relRows];

  if (!rows || rows.length === 0) continue;

  const features = filterTrails(rows);
  if (features.length === 0) continue;

  const pisteCount = features.filter(f => f.properties?.kind === 'piste').length;
  const polyCount = features.filter(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon').length;
  const liftCount = features.filter(f => f.properties?.kind === 'lift').length;

  const fc = {
    type: 'FeatureCollection',
    properties: {
      id: p.id,
      name: p.name,
      country: p.country,
      region: p.region,
      feature_count: features.length,
      pistes: pisteCount,
      polygons: polyCount,
      lifts: liftCount,
    },
    features,
  };

  const jsonStr = JSON.stringify(fc);
  fs.writeFileSync(path.join(outDir, `${id}.json`), jsonStr);
  exportedSet.add(id);
  manifest[id] = id;
  globalExported++;
}

console.log(`Exported ${globalExported} global ski areas.`);
console.log(`Total exported trail datasets: ${exportedSet.size}`);

// Write manifest
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
console.timeEnd('total_export');
console.log('Systematic trail export completed successfully!');
