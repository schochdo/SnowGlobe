export type AtlasCategory = 'downhill' | 'nordic' | 'touring' | 'ignore';

export interface TopologyFeature {
  id?: string | number;
  properties: Record<string, any>;
  geometry: {
    type: 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
    coordinates: any;
  };
}

// Known upstream OSM tagging errors (e.g. Jackson Hole Rendezvous Trail summer hike)
const OSM_WAY_OVERRIDES: Record<string, AtlasCategory> = {
  '318672212': 'ignore',
  'way/318672212': 'ignore',
  '79ad96794a239398407a1f5da587f4068b74116a': 'ignore',
};

const DEG_TO_RAD = Math.PI / 180;

function fastDistMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
  return Math.hypot(dLat, dLng);
}

function extractFlatCoords(geom: TopologyFeature['geometry']): [number, number][] {
  if (!geom || !geom.coordinates) return [];
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString' || geom.type === 'Polygon') return geom.coordinates.flat(1);
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

function computeLineLengthMeters(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += fastDistMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

// Detects tight summer hiking switchbacks (>125 deg hairpin turns)
function countHairpinSwitchbacks(coords: [number, number][]): number {
  if (coords.length < 3) return 0;
  // Filter out micro-vertices closer than 10m so GPS jitter doesn't look like a switchback
  const pts: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    if (fastDistMeters(pts[pts.length - 1][0], pts[pts.length - 1][1], coords[i][0], coords[i][1]) >= 10) {
      pts.push(coords[i]);
    }
  }
  let hairpins = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const [x3, y3] = pts[i + 1];
    const b1 = Math.atan2(x2 - x1, y2 - y1);
    const b2 = Math.atan2(x3 - x2, y3 - y2);
    let diff = Math.abs(b2 - b1) * (180 / Math.PI);
    if (diff > 180) diff = 360 - diff;
    if (diff >= 125) hairpins++;
  }
  return hairpins;
}

// ~22-meter spatial hash cell key for fast O(1) junction snapping
function isRealName(name?: string): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return (
    n.length > 2 &&
    n !== 'unnamed trail' &&
    n !== 'unnamed' &&
    n !== 'unknown' &&
    n !== 'untitled' &&
    !n.startsWith('track') &&
    !n.startsWith('way ')
  );
}

function cellKey(lng: number, lat: number): string {
  return `${Math.round(lng * 4500)},${Math.round(lat * 4500)}`;
}

function neighborCellKeys(lng: number, lat: number): string[] {
  const cx = Math.round(lng * 4500);
  const cy = Math.round(lat * 4500);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      keys.push(`${cx + dx},${cy + dy}`);
    }
  }
  return keys;
}

/**
 * Runs the 3-Tier Topological Graph Classifier across all pistes and lifts in a ski area.
 * Mutates `feature.properties.atlas_category` in-place and returns the classified array.
 */
export function classifySkiAreaTopology<T extends TopologyFeature>(
  pisteFeatures: T[],
  liftFeatures: TopologyFeature[] = []
): T[] {
  // 1. Collect all lift sample points (interpolated every ~50m along lift lines so mid-stations & terminals match)
  const liftPoints: [number, number][] = [];
  for (const lift of liftFeatures) {
    const coords = extractFlatCoords(lift.geometry);
    for (let i = 0; i < coords.length; i++) {
      liftPoints.push(coords[i]);
      if (i > 0) {
        const [x1, y1] = coords[i - 1];
        const [x2, y2] = coords[i];
        const dist = fastDistMeters(x1, y1, x2, y2);
        const steps = Math.floor(dist / 50);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          liftPoints.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
        }
      }
    }
  }

  const isPointWithinMetersOfLift = (lng: number, lat: number, radiusM: number): boolean => {
    for (let i = 0; i < liftPoints.length; i++) {
      if (fastDistMeters(lng, lat, liftPoints[i][0], liftPoints[i][1]) <= radiusM) return true;
    }
    return false;
  };

  // 2. Pre-screen disciplines & identify candidate Downhill graph nodes
  const downhillCandidates: number[] = [];
  const coordsByIdx: [number, number][][] = new Array(pisteFeatures.length);
  const lengthByIdx: number[] = new Array(pisteFeatures.length);

  for (let i = 0; i < pisteFeatures.length; i++) {
    const feat = pisteFeatures[i];
    const props = feat.properties || {};
    const rawId = String(props.id || props['@id'] || feat.id || '');

    if (OSM_WAY_OVERRIDES[rawId]) {
      props.atlas_category = OSM_WAY_OVERRIDES[rawId];
      continue;
    }

    const coords = extractFlatCoords(feat.geometry);
    coordsByIdx[i] = coords;
    lengthByIdx[i] = computeLineLengthMeters(coords);

    // Normalize tags across both raw OSM tags and OpenSkiData `uses` arrays
    const rawType = String(props['piste:type'] || props.type || '').toLowerCase();
    const usesArr: string[] = Array.isArray(props.uses) ? props.uses.map((u: any) => String(u).toLowerCase()) : [];
    const types = new Set([
      ...rawType.split(/[;+,]/).map(s => s.trim()).filter(Boolean),
      ...usesArr,
    ]);

    const grooming = String(props['piste:grooming'] || props.grooming || '').toLowerCase();
    const patrolled = String(props.patrolled || props['piste:patrolled'] || '').toLowerCase();
    const highway = String(props.highway || '').toLowerCase();
    const name = String(props.name || props['piste:name'] || props.ref || '').trim();

    // TIER 2A: Strict Nordic Isolation (Fixes Levi / Scandinavia & Mt. Baker USFS roads)
    // A Nordic trail NEVER becomes downhill just because it has `hike` or passes under a lift.
    if (types.has('nordic') && !types.has('downhill') && !types.has('freeride')) {
      // Drop unnamed short logging road stubs tagged nordic/hike
      if (!name && ['track', 'service', 'footway', 'path'].includes(highway) && lengthByIdx[i] < 400) {
        props.atlas_category = 'ignore';
      } else {
        props.atlas_category = 'nordic';
      }
      continue;
    }

    // TIER 2B: Pure Ski Touring (Uphill skin tracks & backcountry tours)
    if (types.has('skitour') && !types.has('downhill')) {
      if (!name && ['track', 'service', 'unclassified', 'residential'].includes(highway) && lengthByIdx[i] < 350) {
        props.atlas_category = 'ignore';
      } else {
        props.atlas_category = 'touring';
      }
      continue;
    }

    // Ignore non-ski paths (winter_hike, hike, sled, snowshoe, fatbike) unless tagged downhill/freeride
    if (!types.has('downhill') && !types.has('freeride') && !types.has('connection')) {
      props.atlas_category = 'ignore';
      continue;
    }

    // Explicit out-of-bounds patrol tag goes straight to touring
    if (patrolled === 'no') {
      props.atlas_category = 'touring';
      continue;
    }

    // Check for summer hiking trails masquerading as pistes (e.g. highway=path/footway with no grooming & sharp switchbacks)
    if (['path', 'footway', 'track', 'bridleway'].includes(highway) && !grooming) {
      const switchbacks = countHairpinSwitchbacks(coords);
      if (switchbacks >= 3) {
        props.atlas_category = 'ignore';
        continue;
      }
    }

    downhillCandidates.push(i);
  }

  // 3. TIER 1: Build Spatial Adjacency Graph for Downhill Candidates (Solves Valpreveyre 1km Fracture)
  const gridMap = new Map<string, number[]>();
  const nameMap = new Map<string, number[]>();

  for (const idx of downhillCandidates) {
    const coords = coordsByIdx[idx];
    if (coords.length === 0) continue;

    // Index start, end, and every 5th vertex for polygon/bowl & mid-run junctions
    const sampleIndices = new Set<number>([0, coords.length - 1]);
    for (let k = 0; k < coords.length; k += 5) sampleIndices.add(k);

    for (const k of sampleIndices) {
      const [lng, lat] = coords[k];
      const key = cellKey(lng, lat);
      let list = gridMap.get(key);
      if (!list) {
        list = [];
        gridMap.set(key, list);
      }
      list.push(idx);
    }

    // Also index by normalized trail name within the same resort so multi-segment named pistes chain cleanly
    const rawName = String(pisteFeatures[idx].properties?.name || pisteFeatures[idx].properties?.['piste:name'] || '')
      .toLowerCase()
      .trim();
    if (isRealName(rawName)) {
      let nList = nameMap.get(rawName);
      if (!nList) {
        nList = [];
        nameMap.set(rawName, nList);
      }
      nList.push(idx);
    }
  }

  // 4. Seed BFS with all downhill segments within 350m of any lift (or all candidates if no lifts exist in dataset)
  const liftServed = new Set<number>();
  const queue: { idx: number; dist: number }[] = [];

  if (liftPoints.length === 0) {
    // Fallback if a small resort dataset has no aerialway features loaded yet
    for (const idx of downhillCandidates) liftServed.add(idx);
  } else {
    for (const idx of downhillCandidates) {
      const coords = coordsByIdx[idx];
      const touchesLift = coords.some(([lng, lat]) => isPointWithinMetersOfLift(lng, lat, 350));
      if (touchesLift) {
        liftServed.add(idx);
        queue.push({ idx, dist: 0 });
      }
    }
  }

  // 5. Propagate `liftServed` across connected downhill segments up to 8,000m chain distance
  const MAX_CHAIN_METERS = 8000;
  while (queue.length > 0) {
    const { idx, dist } = queue.shift()!;
    const coords = coordsByIdx[idx];
    const neighbors = new Set<number>();

    const checkPoints = [coords[0], coords[coords.length - 1], coords[Math.floor(coords.length / 2)]].filter(Boolean);
    for (const [lng, lat] of checkPoints) {
      for (const nKey of neighborCellKeys(lng, lat)) {
        const bucket = gridMap.get(nKey);
        if (bucket) {
          for (const nIdx of bucket) neighbors.add(nIdx);
        }
      }
    }

    const rawName = String(pisteFeatures[idx].properties?.name || pisteFeatures[idx].properties?.['piste:name'] || '')
      .toLowerCase()
      .trim();
    if (isRealName(rawName)) {
      const sameName = nameMap.get(rawName);
      if (sameName) {
        for (const nIdx of sameName) neighbors.add(nIdx);
      }
    }

    for (const nIdx of neighbors) {
      if (liftServed.has(nIdx)) continue;
      const nextDist = dist + lengthByIdx[nIdx];
      if (nextDist <= MAX_CHAIN_METERS) {
        liftServed.add(nIdx);
        queue.push({ idx: nIdx, dist: nextDist });
      }
    }
  }

  // 6. Finalize Downhill vs. Backcountry Touring + Dead-End Summer Trail Sink Check
  for (const idx of downhillCandidates) {
    const feat = pisteFeatures[idx];
    const props = feat.properties || {};
    const coords = coordsByIdx[idx];
    const highway = String(props.highway || '').toLowerCase();
    const grooming = String(props['piste:grooming'] || props.grooming || '').toLowerCase();

    if (!liftServed.has(idx)) {
      props.atlas_category = 'touring';
      continue;
    }

    // Dead-End Canyon Sink Check (Catches summer hiking trails starting near a summit tram
    // that drop into an un-lifted backcountry canyon and never return to a lift or another run)
    if (['path', 'footway', 'track'].includes(highway) && !grooming && coords.length >= 2) {
      const endPt = coords[coords.length - 1];
      const endNearLift = isPointWithinMetersOfLift(endPt[0], endPt[1], 450);
      const endNeighbors = neighborCellKeys(endPt[0], endPt[1])
        .flatMap(k => gridMap.get(k) || [])
        .filter(nIdx => nIdx !== idx && liftServed.has(nIdx));

      if (!endNearLift && endNeighbors.length === 0) {
        props.atlas_category = 'touring';
        continue;
      }
    }

    props.atlas_category = 'downhill';
  }

  return pisteFeatures;
}
