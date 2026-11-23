#!/usr/bin/env node
/**
 * compute_resort_stats_from_trails.cjs
 *
 * Computes geometry-verified summit/base elevation, vertical drop, piste length (km/mi),
 * lift count, and run count for every resort in public/data/global_ski_areas.json
 * directly from its 3D trail & lift GeoJSON in public/data/trails/<id>.json.
 *
 * Preserves official specs for verified resorts (where avg_snowfall_in != null).
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const TRAILS_DIR = path.join(__dirname, '../public/data/trails');

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

function collectElevations(geometry, out) {
  if (!geometry) return;
  const visit = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    if (typeof arr[0] === 'number') {
      if (arr.length >= 3 && typeof arr[2] === 'number' && isFinite(arr[2]) && arr[2] > -500 && arr[2] < 9000) {
        out.push(arr[2]);
      }
      return;
    }
    for (const item of arr) visit(item);
  };
  visit(geometry.coordinates);
}

const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

let processed = 0;
let updatedElev = 0;
let updatedTrailKm = 0;
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

  const features = tfc.features || [];
  if (features.length === 0) continue;

  const isNordic = p.category === 'nordic';
  const isVerifiedOfficial = p.avg_snowfall_in != null;

  const lifts = features.filter((feat) => feat.properties?.kind === 'lift');
  const targetPistes = features.filter(
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
  }

  // Update lift & run counts
  if (isNordic) {
    if (targetPistes.length > 0) {
      p.run_count = targetPistes.length;
      p.infrastructure = `${targetPistes.length} trails`;
    }
  } else {
    if (lifts.length > 0 || targetPistes.length > 0) {
      p.lift_count = lifts.length;
      p.run_count = targetPistes.length;
      p.infrastructure = `${lifts.length} lifts · ${targetPistes.length} pistes`;
    }
  }

  // Compute geometry-verified summit/base/vertical (preserve verified official specs)
  if (!isVerifiedOfficial) {
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
        // Sanity check: vertical drop <= 8500 ft (prevents corrupted DEM spikes)
        if (vertFt > 0 && vertFt <= 8500) {
          p.summit_elev_ft = summitFt;
          p.base_elev_ft = baseFt;
          p.vertical_ft = vertFt;
          updatedElev++;
        }
      }
    }
  }

  processed++;
}

fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
console.log(
  `Computed 3D trail stats: processed=${processed}, updatedElev=${updatedElev}, updatedTrailKm=${updatedTrailKm}, missingTrailFile=${missingTrailFile}`
);
