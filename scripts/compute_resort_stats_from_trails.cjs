#!/usr/bin/env node
/**
 * compute_resort_stats_from_trails.cjs
 *
 * Computes geometry-verified summit/base elevation, vertical drop, piste/network
 * length (km/mi), lift count, and run count for every ski area in
 * public/data/global_ski_areas.json:
 *
 *   1. Reclassifies genuine alpine ski resorts (chairlifts/T-bars + alpine pistes or
 *      explicit alpine resort naming) that were previously misclassified as `nordic`
 *      when regional cross-country trails flooded their OpenSkiData relation.
 *   2. Downhill (`category === 'downhill'`):
 *      - Uses exact `resort_trails (resort_id, trail_id)` membership in trails.db
 *        (filtered strictly to valid resort IDs in global_ski_areas.json so phantom
 *        anonymous cluster IDs cannot block unclaimed pistes).
 *      - Falls back to unclaimed pistes/lifts within 2.5 km guarded by same-category
 *        Voronoi proximity.
 *   3. Nordic (`category === 'nordic'`):
 *      - Replaces OpenSkiData's broken unbounded flood-fill (which starved polygon-fenced
 *        stadiums like Birkebeineren at 1.9 km, Holmenkollen at 8.9 km, and Kincaid Park
 *        at null while dumping 1,481.6 km onto neighboring Sjusjøen and 186.5 km onto
 *        APU Mahaffey) with Voronoi-Bounded Connected-Network BFS (15 km max Voronoi
 *        radius, 250 m trailhead/road-crossing connectivity, excluding ungroomed
 *        `grooming=backcountry` routes unless explicitly local).
 *      - Synchronizes `public/data/trails/<id>.json` and `public/data/trails/manifest.json`
 *        for every Nordic center so rendered map networks match directory stats 1:1.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const TRAILS_DIR = path.join(__dirname, '../public/data/trails');
const MANIFEST_PATH = path.join(TRAILS_DIR, 'manifest.json');
const DB_PATH = path.join(__dirname, '../data_pipeline/trails.db');

const VERIFIED_OFFICIAL_MATCHES = [
  { match: 'mt. bachelor', altMatch: 'mount bachelor', region: 'Oregon' },
  { match: 'crystal mountain', region: 'Washington' },
  { match: 'stevens pass', region: 'Washington' },
  { match: 'mt. hood meadows', altMatch: 'mount hood meadows', region: 'Oregon' },
  { match: 'timberline', region: 'Oregon' },
  { match: 'whitefish mountain', region: 'Montana' },
  { match: 'bridger bowl', region: 'Montana' },
  { match: 'schweitzer', region: 'Idaho' },
  { match: 'grand targhee', region: 'Wyoming' },
  { match: 'brighton', region: 'Utah' },
  { match: 'solitude', region: 'Utah' },
  { match: 'deer valley', region: 'Utah' },
  { match: 'snowbasin', region: 'Utah' },
  { match: 'taos ski valley', region: 'New Mexico' },
  { match: 'wolf creek', region: 'Colorado' },
  { match: 'loveland ski area', altMatch: 'loveland', region: 'Colorado' },
  { match: 'monarch mountain', region: 'Colorado' },
  { match: 'crested butte', region: 'Colorado' },
  { match: 'keystone', region: 'Colorado' },
  { match: 'beaver creek', region: 'Colorado' },
  { match: 'winter park', region: 'Colorado' },
  { match: 'purgatory', region: 'Colorado' },
  { match: 'sun peaks', region: 'British Columbia' },
  { match: 'big white', region: 'British Columbia' },
  { match: 'silverstar', altMatch: 'silver star', region: 'British Columbia' },
  { match: 'red mountain', region: 'British Columbia' },
  { match: 'whitewater', region: 'British Columbia' },
  { match: 'kicking horse', region: 'British Columbia' },
  { match: 'fernie alpine', region: 'British Columbia' },
  { match: 'sunshine village', region: 'Alberta' },
  { match: 'lake louise', region: 'Alberta' },
  { match: 'killington', region: 'Vermont' },
  { match: 'jay peak', region: 'Vermont' },
  { match: 'stowe', region: 'Vermont' },
  { match: 'sugarbush', region: 'Vermont' },
  { match: 'sugarloaf', region: 'Maine' },
  { match: 'sunday river', region: 'Maine' },
  { match: 'whiteface', region: 'New York' },
];

const PROTECTED_NORDIC_RE =
  /nordic|langlauf|loipe|ski de fond|sci di fondo|cross[- ]country|\bxc\b|skistadion|skiskytter|biathlon|maastohiihto|hiihtostadion|latu|spår|callaghan|pokljuka|antholz|anterselva|bessans|tehvandi|itasca|rondane|vålådalen|skalka/i;

const EXPLICIT_ALPINE_RE =
  /alpinpark|ski\s*are[aá]l|skigebiet|lyžařský\s*vlek|rofanlifte|hiihtokeskus|"erste berg"\s*masserberg|^plešivec$|^saariselk[aä]$|^mont grand-fonds$/i;

function isVerifiedOfficialVertical(p) {
  if (p.category !== 'downhill') return false;
  const nameLower = String(p.name || '').toLowerCase();
  const regionLower = String(p.region || '').toLowerCase();
  return VERIFIED_OFFICIAL_MATCHES.some((s) => {
    const regionMatch = regionLower.includes(s.region.toLowerCase());
    const nameMatch =
      nameLower.includes(s.match) || (s.altMatch && nameLower.includes(s.altMatch));
    return regionMatch && nameMatch;
  });
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

function lineLengthKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (Array.isArray(a) && Array.isArray(b) && a.length >= 2 && b.length >= 2) {
      km += haversineKm(a[0], a[1], b[0], b[1]);
    }
  }
  return km;
}

function extractLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates || []];
  if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
  return [];
}

function getFeatureRepPoint(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const c = geometry.coordinates;
  if (geometry.type === 'Point') return c.length >= 2 ? [c[0], c[1]] : null;
  if (geometry.type === 'LineString') {
    const pt = c[Math.floor(c.length / 2)];
    return pt && pt.length >= 2 ? [pt[0], pt[1]] : null;
  }
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
    const ring = c[0];
    if (!Array.isArray(ring) || ring.length === 0) return null;
    const pt = ring[Math.floor(ring.length / 2)];
    return pt && pt.length >= 2 ? [pt[0], pt[1]] : null;
  }
  if (geometry.type === 'MultiPolygon') {
    const ring = c[0]?.[0];
    if (!Array.isArray(ring) || ring.length === 0) return null;
    const pt = ring[Math.floor(ring.length / 2)];
    return pt && pt.length >= 2 ? [pt[0], pt[1]] : null;
  }
  return null;
}

function collectElevations(geometry, out) {
  if (!geometry) return;
  const visit = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    if (typeof arr[0] === 'number') {
      if (
        arr.length >= 3 &&
        typeof arr[2] === 'number' &&
        isFinite(arr[2]) &&
        arr[2] > -500 &&
        arr[2] < 9000
      ) {
        out.push(arr[2]);
      }
      return;
    }
    for (const item of arr) visit(item);
  };
  visit(geometry.coordinates);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`trails.db not found at ${DB_PATH}`);
  process.exit(1);
}

const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const validResortIds = new Set(fc.features.map((f) => f.properties?.id).filter(Boolean));

// 1. Load relation memberships from trails.db (ignoring phantom cluster resort_ids)
const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
const ownTrailsByResort = new Map();
const claimedByAnyResort = new Set();

for (const row of db.prepare('SELECT resort_id, trail_id FROM resort_trails').iterate()) {
  if (!validResortIds.has(row.resort_id)) continue;
  let set = ownTrailsByResort.get(row.resort_id);
  if (!set) {
    set = new Set();
    ownTrailsByResort.set(row.resort_id, set);
  }
  set.add(row.trail_id);
  claimedByAnyResort.add(row.trail_id);
}

console.log(
  `Loaded valid resort_trails: ${ownTrailsByResort.size} resorts, ${claimedByAnyResort.size} claimed trail IDs.`
);

// 2. Reclassify disguised Downhill Alpine Ski Areas previously swamped by regional Nordic trails
let reclassifiedAlpineCount = 0;
for (const f of fc.features) {
  const p = f.properties;
  if (!p?.id || p.category !== 'nordic') continue;
  const nameTrim = String(p.name || '').trim();
  if (PROTECTED_NORDIC_RE.test(nameTrim)) continue;

  let ownAlpineLifts = 0;
  let ownDownhillPistes = 0;
  const ownSet = ownTrailsByResort.get(p.id);
  const trailPath = path.join(TRAILS_DIR, `${p.id}.json`);
  const [rLng, rLat] = f.geometry?.coordinates || [0, 0];

  if (fs.existsSync(trailPath)) {
    try {
      const tfc = JSON.parse(fs.readFileSync(trailPath, 'utf8'));
      for (const feat of tfc.features || []) {
        const fid = String(feat.properties?.id ?? feat.id ?? '');
        if (ownSet && ownSet.size > 0) {
          if (!fid || !ownSet.has(fid)) continue;
        } else {
          if (fid && claimedByAnyResort.has(fid)) continue;
          const pt = getFeatureRepPoint(feat.geometry);
          if (!pt || haversineKm(rLng, rLat, pt[0], pt[1]) > 1.5) continue;
        }
        const fp = feat.properties || {};
        if (
          fp.kind === 'lift' &&
          (!fp.status || fp.status === 'operating') &&
          !['magic_carpet', 'rope_tow'].includes(fp.lift_type)
        ) {
          ownAlpineLifts++;
        } else if (fp.kind === 'piste' && fp.atlas_category === 'downhill') {
          ownDownhillPistes++;
        }
      }
    } catch (_) {}
  }

  if (EXPLICIT_ALPINE_RE.test(nameTrim) || (ownAlpineLifts >= 2 && ownDownhillPistes >= 4)) {
    p.category = 'downhill';
    p.archetype = 'Alpine Ski Area';
    reclassifiedAlpineCount++;
  }
}
console.log(`Reclassified ${reclassifiedAlpineCount} disguised alpine ski areas from nordic -> downhill.`);

// 3. Build Voronoi-Bounded Connected Nordic Networks from trails.db
const CELL = 0.0025; // ~250 m spatial grid for endpoint/vertex connectivity
const MAX_VORONOI_KM = 15.0;
const CONNECT_KM = 0.25;

const nordicTrails = [];
const cellMap = new Map();

for (const row of db
  .prepare('SELECT id, min_lng, max_lng, min_lat, max_lat, geojson FROM trails WHERE kind = ?')
  .iterate('piste')) {
  let feat;
  try {
    feat = JSON.parse(row.geojson);
  } catch {
    continue;
  }
  const fp = feat.properties || {};
  const ptype = fp['piste:type'];
  const uses = Array.isArray(fp.uses) ? fp.uses : [];
  if (ptype === 'downhill') continue;
  if (ptype !== 'nordic' && !uses.includes('nordic')) continue;

  const lines = extractLines(feat.geometry);
  if (lines.length === 0) continue;

  let km = 0;
  const pts = [];
  for (const line of lines) {
    km += lineLengthKm(line);
    for (let i = 0; i < line.length; i++) {
      if (i === 0 || i === line.length - 1 || i % 4 === 0) {
        pts.push([line[i][0], line[i][1]]);
      }
    }
  }
  if (pts.length === 0 || km <= 0) continue;

  const fid = String(fp.id ?? feat.id ?? row.id);
  fp.id = fid;
  fp.atlas_category = 'nordic';
  delete feat.id;

  const idx = nordicTrails.length;
  nordicTrails.push({
    idx,
    id: fid,
    cx: (row.min_lng + row.max_lng) / 2,
    cy: (row.min_lat + row.max_lat) / 2,
    km,
    pts,
    isBackcountryGroom: fp.grooming === 'backcountry',
    feature: feat,
  });

  const seenCells = new Set();
  for (const [x, y] of pts) {
    const ck = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    if (!seenCells.has(ck)) {
      seenCells.add(ck);
      let arr = cellMap.get(ck);
      if (!arr) {
        arr = [];
        cellMap.set(ck, arr);
      }
      arr.push(idx);
    }
  }
}
db.close();

const nordicPins = [];
const nordicPinGrid = new Map();
for (const f of fc.features) {
  const p = f.properties;
  const coords = f.geometry?.coordinates;
  if (!p?.id || p.category !== 'nordic' || !Array.isArray(coords) || coords.length < 2) continue;
  const pin = {
    pinIdx: nordicPins.length,
    id: p.id,
    name: p.name,
    country: p.country,
    region: p.region,
    lng: coords[0],
    lat: coords[1],
  };
  nordicPins.push(pin);
  const gk = `${Math.floor(pin.lng)},${Math.floor(pin.lat)}`;
  if (!nordicPinGrid.has(gk)) nordicPinGrid.set(gk, []);
  nordicPinGrid.get(gk).push(pin);
}

const voronoiOwner = new Int32Array(nordicTrails.length).fill(-1);
const minPinDist = new Float32Array(nordicTrails.length).fill(1e9);

for (const t of nordicTrails) {
  const gx = Math.floor(t.cx);
  const gy = Math.floor(t.cy);
  let best = -1;
  let bestD = MAX_VORONOI_KM;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = nordicPinGrid.get(`${gx + dx},${gy + dy}`);
      if (!bucket) continue;
      for (const pin of bucket) {
        let d = haversineKm(t.cx, t.cy, pin.lng, pin.lat);
        if (d < bestD + 5.0) {
          for (const [px, py] of t.pts) {
            const dp = haversineKm(px, py, pin.lng, pin.lat);
            if (dp < d) d = dp;
          }
        }
        if (d < bestD) {
          bestD = d;
          best = pin.pinIdx;
        }
      }
    }
  }
  voronoiOwner[t.idx] = best;
  minPinDist[t.idx] = bestD;
}

const candsByPin = nordicPins.map(() => []);
for (let i = 0; i < nordicTrails.length; i++) {
  const owner = voronoiOwner[i];
  if (owner >= 0) candsByPin[owner].push(i);
}

const acceptedNordicByResort = new Map();
const manifest = fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  : {};
let syncedNordicFiles = 0;

for (const pin of nordicPins) {
  const rawCands = candsByPin[pin.pinIdx];
  const ownSet = ownTrailsByResort.get(pin.id) || new Set();

  // Exclude ungroomed backcountry forest trails unless explicitly local to this center
  const cands = rawCands.filter((ti) => {
    const t = nordicTrails[ti];
    if (!t.isBackcountryGroom) return true;
    return ownSet.has(t.id) && minPinDist[ti] <= 3.0;
  });

  const candSet = new Set(cands);
  const visited = new Set();
  const queue = [];

  for (const ti of cands) {
    const t = nordicTrails[ti];
    if (minPinDist[ti] <= 2.0 || (ownSet.has(t.id) && minPinDist[ti] <= 5.0)) {
      visited.add(ti);
      queue.push(ti);
    }
  }

  // Fallback for pins dropped slightly off-trailhead (2.0..3.5 km)
  if (queue.length === 0 && cands.length > 0) {
    for (const ti of cands) {
      const t = nordicTrails[ti];
      if (minPinDist[ti] <= 3.5 || (ownSet.has(t.id) && minPinDist[ti] <= 8.0)) {
        visited.add(ti);
        queue.push(ti);
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const ti = queue[head++];
    const t = nordicTrails[ti];
    for (const [x, y] of t.pts) {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = cellMap.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const ni of bucket) {
            if (visited.has(ni) || !candSet.has(ni)) continue;
            const nt = nordicTrails[ni];
            let connected = false;
            for (const [nx, ny] of nt.pts) {
              if (haversineKm(x, y, nx, ny) <= CONNECT_KM) {
                connected = true;
                break;
              }
            }
            if (connected) {
              visited.add(ni);
              queue.push(ni);
            }
          }
        }
      }
    }
  }

  const acceptedFeatures = [...visited].map((ti) => nordicTrails[ti].feature);
  acceptedNordicByResort.set(pin.id, acceptedFeatures);

  // Sync public/data/trails/<id>.json so map rendering matches computed network 1:1
  if (acceptedFeatures.length > 0) {
    const trailPath = path.join(TRAILS_DIR, `${pin.id}.json`);
    let existingContext = [];
    if (fs.existsSync(trailPath)) {
      try {
        const existingFc = JSON.parse(fs.readFileSync(trailPath, 'utf8'));
        // Retain non-nordic context (e.g. nearby ski-jump/biathlon lifts or local downhill runs)
        existingContext = (existingFc.features || [])
          .filter((ef) => ef.properties?.atlas_category !== 'nordic')
          .map((ef) => {
            if (ef.properties && !ef.properties.id && ef.id !== undefined) {
              ef.properties.id = String(ef.id);
            }
            delete ef.id;
            return ef;
          });
      } catch (_) {}
    }

    const mergedFeatures = [...existingContext, ...acceptedFeatures];
    const polyCount = mergedFeatures.filter(
      (mf) => mf.geometry?.type === 'Polygon' || mf.geometry?.type === 'MultiPolygon'
    ).length;
    const liftCount = mergedFeatures.filter((mf) => mf.properties?.kind === 'lift').length;
    const pisteCount = mergedFeatures.filter((mf) => mf.properties?.kind === 'piste').length;

    const outFc = {
      type: 'FeatureCollection',
      properties: {
        id: pin.id,
        name: pin.name,
        country: pin.country,
        region: pin.region,
        feature_count: mergedFeatures.length,
        pistes: pisteCount,
        polygons: polyCount,
        lifts: liftCount,
      },
      features: mergedFeatures,
    };

    fs.writeFileSync(trailPath, JSON.stringify(outFc));
    if (!manifest[pin.id]) {
      manifest[pin.id] = pin.id;
    }
    syncedNordicFiles++;
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
console.log(
  `Partitioned ${nordicTrails.length} Nordic segments across ${nordicPins.length} Nordic centers (synced ${syncedNordicFiles} trail files).`
);

// 4. Build spatial pin index for Downhill unclaimed Voronoi guard
const pinsByCell = new Map();
const pinCellKey = (lng, lat) => `${Math.floor(lng * 2)},${Math.floor(lat * 2)}`;

for (const f of fc.features) {
  const p = f.properties;
  const coords = f.geometry?.coordinates;
  if (!p?.id || !Array.isArray(coords) || coords.length < 2) continue;
  const pin = {
    id: p.id,
    lng: coords[0],
    lat: coords[1],
    category: p.category || 'downhill',
  };
  const key = pinCellKey(pin.lng, pin.lat);
  let arr = pinsByCell.get(key);
  if (!arr) {
    arr = [];
    pinsByCell.set(key, arr);
  }
  arr.push(pin);
}

function getNearbySameCategoryPins(id, lng, lat, category) {
  const cx = Math.floor(lng * 2);
  const cy = Math.floor(lat * 2);
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = pinsByCell.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const pin of bucket) {
        if (pin.id === id || pin.category !== category) continue;
        if (haversineKm(lng, lat, pin.lng, pin.lat) <= 12) {
          out.push(pin);
        }
      }
    }
  }
  return out;
}

// 5. Compute stats for every ski area in global_ski_areas.json
let processed = 0;
let relationScopedCount = 0;
let voronoiScopedCount = 0;
let nordicConnectedCount = 0;
let updatedElev = 0;
let updatedTrailKm = 0;
let resetTrailKm = 0;
let missingTrailFile = 0;

for (const f of fc.features) {
  const p = f.properties;
  if (!p || !p.id) continue;

  const isNordic = p.category === 'nordic';
  const keepOfficialElev = isVerifiedOfficialVertical(p);
  const [resortLng, resortLat] = f.geometry.coordinates;

  let lifts = [];
  let targetPistes = [];

  if (isNordic) {
    targetPistes = acceptedNordicByResort.get(p.id) || [];
    nordicConnectedCount++;
  } else {
    const trailPath = path.join(TRAILS_DIR, `${p.id}.json`);
    if (!fs.existsSync(trailPath)) {
      missingTrailFile++;
      continue;
    }

    let tfc;
    try {
      tfc = JSON.parse(fs.readFileSync(trailPath, 'utf8'));
    } catch {
      continue;
    }

    const allFeatures = tfc.features || [];
    if (allFeatures.length === 0) continue;

    const ownSet = ownTrailsByResort.get(p.id);
    let scopedFeatures;

    if (ownSet && ownSet.size > 0) {
      scopedFeatures = allFeatures.filter((feat) => {
        const fid = String(feat.properties?.id ?? feat.id ?? '');
        return fid && ownSet.has(fid);
      });
      relationScopedCount++;
    } else {
      const neighbors = getNearbySameCategoryPins(
        p.id,
        resortLng,
        resortLat,
        p.category || 'downhill'
      );
      scopedFeatures = allFeatures.filter((feat) => {
        const fid = String(feat.properties?.id ?? feat.id ?? '');
        if (fid && claimedByAnyResort.has(fid)) return false;
        const pt = getFeatureRepPoint(feat.geometry);
        if (!pt) return false;
        const dSelf = haversineKm(resortLng, resortLat, pt[0], pt[1]);
        if (dSelf > 2.5) return false;
        for (const nb of neighbors) {
          if (haversineKm(nb.lng, nb.lat, pt[0], pt[1]) < dSelf) return false;
        }
        return true;
      });
      voronoiScopedCount++;
    }

    lifts = scopedFeatures.filter(
      (feat) =>
        feat.properties?.kind === 'lift' &&
        (!feat.properties?.status || feat.properties.status === 'operating')
    );
    targetPistes = scopedFeatures.filter(
      (feat) =>
        feat.properties?.kind === 'piste' && feat.properties?.atlas_category === 'downhill'
    );
  }

  let totalKm = 0;
  for (const piste of targetPistes) {
    for (const line of extractLines(piste.geometry)) {
      totalKm += lineLengthKm(line);
    }
  }

  if (totalKm > 0) {
    p.trail_km = Math.round(totalKm * 10) / 10;
    p.trail_mi = Math.round(totalKm * 0.621371 * 10) / 10;
    updatedTrailKm++;
  } else if (p.trail_km) {
    p.trail_km = null;
    p.trail_mi = null;
    resetTrailKm++;
  }

  if (isNordic) {
    p.lift_count = null;
    if (targetPistes.length > 0) {
      p.run_count = targetPistes.length;
      p.infrastructure = `${targetPistes.length} trails`;
    } else {
      p.run_count = null;
      p.infrastructure = 'Cross-Country Nordic Center';
    }
  } else {
    if (lifts.length > 0 || targetPistes.length > 0) {
      p.lift_count = lifts.length;
      p.run_count = targetPistes.length;
      p.infrastructure = `${lifts.length} lifts · ${targetPistes.length} pistes`;
    } else {
      p.lift_count = null;
      p.run_count = null;
      p.infrastructure = 'Alpine Ski Area';
    }
  }

  if (!keepOfficialElev) {
    const elevs = [];
    const elevSources = isNordic ? targetPistes : [...lifts, ...targetPistes];
    for (const feat of elevSources) {
      collectElevations(feat.geometry, elevs);
    }
    if (elevs.length >= 2) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const z of elevs) {
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (isFinite(minZ) && isFinite(maxZ) && maxZ > minZ) {
        const summitFt = Math.round(maxZ * 3.28084);
        const baseFt = Math.round(minZ * 3.28084);
        const vertFt = Math.max(0, summitFt - baseFt);
        if (vertFt > 0 && vertFt <= 8500) {
          p.summit_elev_ft = summitFt;
          p.base_elev_ft = baseFt;
          p.vertical_ft = vertFt;
          updatedElev++;
        }
      }
    } else {
      p.summit_elev_ft = 0;
      p.base_elev_ft = 0;
      p.vertical_ft = 0;
    }
  }

  processed++;
}

fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
console.log(
  `Computed 3D trail stats: processed=${processed}, downhillRelation=${relationScopedCount}, downhillVoronoi=${voronoiScopedCount}, nordicConnected=${nordicConnectedCount}, updatedElev=${updatedElev}, updatedTrailKm=${updatedTrailKm}, resetTrailKm=${resetTrailKm}, missingTrailFile=${missingTrailFile}`
);
