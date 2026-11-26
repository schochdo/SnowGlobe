#!/usr/bin/env node
/**
 * compute_resort_stats_from_trails.cjs
 *
 * Computes relation-scoped, geometry-verified summit/base elevation, vertical drop,
 * piste length (km/mi), lift count, and run count for every resort in
 * public/data/global_ski_areas.json using:
 *   1. Exact `resort_trails (resort_id, trail_id)` membership in data_pipeline/trails.db
 *      intersected with pre-baked `atlas_category` in public/data/trails/<id>.json.
 *   2. For resorts without relation rows in `resort_trails`, only unclaimed features
 *      within 2.5 km that are closer to this resort pin than to any neighboring
 *      same-category resort pin (Voronoi guard).
 *
 * Preserves official vertical/summit/base specs for the curated verified North American
 * resorts in sanitize_global_ski_areas.cjs while fixing neighbor-bleed everywhere else.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const TRAILS_DIR = path.join(__dirname, '../public/data/trails');
const DB_PATH = path.join(__dirname, '../data_pipeline/trails.db');

// Official verified North American resorts whose summit/base/vertical come from official specs
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

// 1. Load relation memberships from trails.db
if (!fs.existsSync(DB_PATH)) {
  console.error(`trails.db not found at ${DB_PATH}`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
const ownTrailsByResort = new Map();
const claimedByAnyResort = new Set();

for (const row of db.prepare('SELECT resort_id, trail_id FROM resort_trails').iterate()) {
  let set = ownTrailsByResort.get(row.resort_id);
  if (!set) {
    set = new Set();
    ownTrailsByResort.set(row.resort_id, set);
  }
  set.add(row.trail_id);
  claimedByAnyResort.add(row.trail_id);
}
db.close();
console.log(
  `Loaded resort_trails: ${ownTrailsByResort.size} resorts, ${claimedByAnyResort.size} unique claimed trail IDs.`
);

// 2. Load global_ski_areas.json and build spatial pin index for Voronoi guard
const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
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

let processed = 0;
let relationScopedCount = 0;
let voronoiScopedCount = 0;
let updatedElev = 0;
let updatedTrailKm = 0;
let resetTrailKm = 0;
let missingTrailFile = 0;

for (const f of fc.features) {
  const p = f.properties;
  if (!p || !p.id) continue;

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

  const isNordic = p.category === 'nordic';
  const keepOfficialElev = isVerifiedOfficialVertical(p);
  const [resortLng, resortLat] = f.geometry.coordinates;

  // Scope features to this resort only (eliminate neighbor-bleed)
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

  const lifts = scopedFeatures.filter(
    (feat) =>
      feat.properties?.kind === 'lift' &&
      (!feat.properties?.status || feat.properties.status === 'operating')
  );
  const targetPistes = scopedFeatures.filter(
    (feat) =>
      feat.properties?.kind === 'piste' &&
      feat.properties?.atlas_category === (isNordic ? 'nordic' : 'downhill')
  );

  // Compute total piste/trail length in km
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

  // Update lift & run counts
  if (isNordic) {
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

  // Compute geometry-verified summit/base/vertical (preserve verified official specs)
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
      // Clear neighbor-bleed elevation if resort has no own elevation data
      p.summit_elev_ft = 0;
      p.base_elev_ft = 0;
      p.vertical_ft = 0;
    }
  }

  processed++;
}

fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
console.log(
  `Computed relation-scoped 3D trail stats: processed=${processed}, relationScoped=${relationScopedCount}, voronoiScoped=${voronoiScopedCount}, updatedElev=${updatedElev}, updatedTrailKm=${updatedTrailKm}, resetTrailKm=${resetTrailKm}, missingTrailFile=${missingTrailFile}`
);
