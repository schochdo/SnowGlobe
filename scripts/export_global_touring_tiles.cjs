#!/usr/bin/env node
/**
 * export_global_touring_tiles.cjs
 *
 * Exports all mapped backcountry ski touring routes (`skitour` ways from
 * data_pipeline/trails.db + the 35 curated Tuckerman Ravine lines) into
 * compact 5° × 5° spatial GeoJSON tiles under `public/data/touring/`
 * with a tiny `manifest.json` index of non-empty cells.
 *
 * Loaded lazily by the client only when the user enables
 * "Backcountry Touring Routes" in the Layers menu.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '../data_pipeline/trails.db');
const TUCKERMAN_PATH = path.join(__dirname, '../public/data/trails/tuckerman-ravine.json');
const OUT_DIR = path.join(__dirname, '../public/data/touring');

if (!fs.existsSync(DB_PATH)) {
  console.error(`trails.db not found at ${DB_PATH}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// Clean existing tile files
for (const file of fs.readdirSync(OUT_DIR)) {
  if (file.endsWith('.json')) {
    fs.unlinkSync(path.join(OUT_DIR, file));
  }
}

function roundCoords(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return coords;
  if (typeof coords[0] === 'number') {
    const out = [
      Math.round(coords[0] * 1e5) / 1e5,
      Math.round(coords[1] * 1e5) / 1e5,
    ];
    if (coords.length >= 3 && typeof coords[2] === 'number' && isFinite(coords[2])) {
      out.push(Math.round(coords[2]));
    }
    return out;
  }
  return coords.map(roundCoords);
}

function getFirstPoint(geom) {
  if (!geom || !geom.coordinates) return null;
  let c = geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' ? [c[0], c[1]] : null;
}

const seenIds = new Set();
const tiles = new Map();
let totalExported = 0;

function addFeature(rawFeature) {
  if (!rawFeature || !rawFeature.geometry) return;
  const p = rawFeature.properties || {};
  if (p.kind === 'lift') return;

  const fid = String(p.id ?? rawFeature.id ?? '');
  if (fid && seenIds.has(fid)) return;

  const pt = getFirstPoint(rawFeature.geometry);
  if (!pt) return;
  const [lng, lat] = pt;
  if (!isFinite(lng) || !isFinite(lat)) return;

  if (fid) seenIds.add(fid);

  const cellLat = Math.floor(lat / 5) * 5;
  const cellLng = Math.floor(lng / 5) * 5;
  const cellKey = `${cellLat}_${cellLng}`;

  const compactFeature = {
    type: 'Feature',
    geometry: {
      type: rawFeature.geometry.type,
      coordinates: roundCoords(rawFeature.geometry.coordinates),
    },
    properties: {
      id: fid || `tour_${totalExported}`,
      kind: 'piste',
      name: p.name || p['piste:name'] || '',
      difficulty: p.difficulty || p['piste:difficulty'] || 'unknown',
      'piste:type': 'skitour',
      atlas_category: 'touring',
      is_touring: true,
    },
  };

  let list = tiles.get(cellKey);
  if (!list) {
    list = [];
    tiles.set(cellKey, list);
  }
  list.push(compactFeature);
  totalExported++;
}

// 1. Include all 35 Tuckerman Ravine backcountry chutes/trails
if (fs.existsSync(TUCKERMAN_PATH)) {
  try {
    const tuckFc = JSON.parse(fs.readFileSync(TUCKERMAN_PATH, 'utf8'));
    for (const f of tuckFc.features || []) {
      addFeature(f);
    }
  } catch (err) {
    console.warn('Could not read tuckerman-ravine.json:', err.message);
  }
}

// 2. Query all skitour ways from trails.db
const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
for (const row of db.prepare(`SELECT geojson FROM trails WHERE geojson LIKE '%"skitour"%'`).iterate()) {
  try {
    const f = JSON.parse(row.geojson);
    const p = f.properties || {};
    const rawType = String(p['piste:type'] || p.type || '').toLowerCase();
    const uses = Array.isArray(p.uses) ? p.uses.map((u) => String(u).toLowerCase()) : [];
    // Only include pure touring routes (not dual-tagged downhill runs)
    if (rawType.includes('downhill') || uses.includes('downhill')) continue;
    addFeature(f);
  } catch (_) {}
}
db.close();

// 3. Write 5° × 5° tiles + manifest
const manifestCells = [];
let totalBytes = 0;

for (const [cellKey, features] of tiles.entries()) {
  const fc = { type: 'FeatureCollection', features };
  const json = JSON.stringify(fc);
  fs.writeFileSync(path.join(OUT_DIR, `${cellKey}.json`), json);
  totalBytes += json.length;
  manifestCells.push(cellKey);
}

manifestCells.sort();
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ cellDeg: 5, count: totalExported, cells: manifestCells })
);

console.log(
  `Exported ${totalExported} backcountry touring routes into ${manifestCells.length} 5°×5° tiles (${(totalBytes / 1024 / 1024).toFixed(2)} MB total).`
);
