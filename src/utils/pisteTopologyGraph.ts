export type AtlasCategory = 'downhill' | 'nordic' | 'touring' | 'ignore';

export interface TopologyFeature {
  id?: string | number;
  properties: Record<string, any>;
  geometry: {
    type: 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
    coordinates: any;
  };
}

const DEG_TO_RAD = Math.PI / 180;

function fastDistMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLng = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
  return Math.hypot(dLat, dLng);
}

function extractFlatCoords(geom: TopologyFeature['geometry']): [number, number, number?][] {
  if (!geom || !geom.coordinates) return [];
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString' || geom.type === 'Polygon') return geom.coordinates.flat(1);
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

function computeLineLengthMeters(coords: [number, number, number?][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += fastDistMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

// Detects tight summer hiking switchbacks (>125 deg hairpin turns)
function countHairpinSwitchbacks(coords: [number, number, number?][]): number {
  if (coords.length < 3) return 0;
  const pts: [number, number, number?][] = [coords[0]];
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

// Ray-casting point-in-polygon algorithm for boundary validation
function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeom(lng: number, lat: number, geom: TopologyFeature['geometry']): boolean {
  if (!geom || !geom.coordinates) return false;
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates;
    if (!rings || rings.length === 0) return false;
    if (!pointInRing(lng, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lng, lat, rings[h])) return false;
    }
    return true;
  }
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (!poly || poly.length === 0) continue;
      if (pointInRing(lng, lat, poly[0])) {
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
          if (pointInRing(lng, lat, poly[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }
  return false;
}

function computeCentroid(coords: [number, number, number?][]): [number, number] {
  let sumLng = 0;
  let sumLat = 0;
  for (const c of coords) {
    sumLng += c[0];
    sumLat += c[1];
  }
  const n = Math.max(1, coords.length);
  return [sumLng / n, sumLat / n];
}

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

// ~22-meter spatial hash cell key for fast O(1) junction snapping
function cellKey(lng: number, lat: number): string {
  return `${Math.round(lng * 4500)},${Math.round(lat * 4500)}`;
}

// ±3 cells (~65m) to bridge cliff bands and minor mapper gaps
function neighborCellKeys(lng: number, lat: number): string[] {
  const cx = Math.round(lng * 4500);
  const cy = Math.round(lat * 4500);
  const keys: string[] = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      keys.push(`${cx + dx},${cy + dy}`);
    }
  }
  return keys;
}

// ~111-meter spatial hash cell key for O(1) glacier/bowl apron runout checks (<= 280m)
function apronCellKey(lng: number, lat: number): string {
  return `${Math.round(lng * 1000)},${Math.round(lat * 1000)}`;
}

function neighborApronCellKeys(lng: number, lat: number): string[] {
  const cx = Math.round(lng * 1000);
  const cy = Math.round(lat * 1000);
  const keys: string[] = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      keys.push(`${cx + dx},${cy + dy}`);
    }
  }
  return keys;
}

interface ApronSample {
  lng: number;
  lat: number;
  z: number | undefined;
  idx: number;
}

/**
 * Runs the 3-Tier Topological Graph Classifier across all pistes and lifts in a ski area.
 * Mutates `feature.properties.atlas_category` in-place and returns the classified array.
 */
export function classifySkiAreaTopology<T extends TopologyFeature>(
  pisteFeatures: T[],
  liftFeatures: TopologyFeature[] = []
): T[] {
  // 0. Extract any boundary polygons (landuse=winter_sports)
  const winterSportsPolygons: TopologyFeature[] = [];
  const allFeatures = [...pisteFeatures, ...liftFeatures];
  for (const f of allFeatures) {
    const lu = String(f.properties?.landuse || '').toLowerCase();
    if (lu === 'winter_sports' && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')) {
      winterSportsPolygons.push(f);
    }
  }

  // 1. Collect all lift sample points (interpolated every ~50m along lift lines)
  // Also collect upperLiftPoints (upper station / upper 70% of span by Z coordinate)
  const liftPoints: [number, number][] = [];
  const upperLiftPoints: [number, number][] = [];

  for (const lift of liftFeatures) {
    const coords = extractFlatCoords(lift.geometry);
    let liftMinZ = Infinity;
    let liftMaxZ = -Infinity;
    for (const c of coords) {
      if (c.length >= 3 && typeof c[2] === 'number' && isFinite(c[2])) {
        if (c[2] < liftMinZ) liftMinZ = c[2];
        if (c[2] > liftMaxZ) liftMaxZ = c[2];
      }
    }
    const hasLiftZ = isFinite(liftMinZ) && isFinite(liftMaxZ) && liftMaxZ > liftMinZ;
    const zThreshold = hasLiftZ ? liftMinZ + 0.30 * (liftMaxZ - liftMinZ) : -Infinity;

    for (let i = 0; i < coords.length; i++) {
      const [lng, lat, z] = coords[i];
      liftPoints.push([lng, lat]);
      const isUpper = hasLiftZ
        ? (typeof z === 'number' && isFinite(z) && z >= zThreshold)
        : (i >= Math.floor(coords.length * 0.3));
      if (isUpper) {
        upperLiftPoints.push([lng, lat]);
      }

      if (i > 0) {
        const [x1, y1] = coords[i - 1];
        const [x2, y2] = coords[i];
        const dist = fastDistMeters(x1, y1, x2, y2);
        const steps = Math.floor(dist / 50);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const interpPt: [number, number] = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
          liftPoints.push(interpPt);
          const interpZ = (typeof coords[i - 1][2] === 'number' && typeof coords[i][2] === 'number')
            ? (coords[i - 1][2]! + (coords[i][2]! - coords[i - 1][2]!) * t)
            : undefined;
          const interpIsUpper = hasLiftZ
            ? (typeof interpZ === 'number' && isFinite(interpZ) && interpZ >= zThreshold)
            : (i >= Math.floor(coords.length * 0.3));
          if (interpIsUpper) {
            upperLiftPoints.push(interpPt);
          }
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

  const isPointWithinMetersOfUpperLift = (lng: number, lat: number, radiusM: number): boolean => {
    const pts = upperLiftPoints.length > 0 ? upperLiftPoints : liftPoints;
    for (let i = 0; i < pts.length; i++) {
      if (fastDistMeters(lng, lat, pts[i][0], pts[i][1]) <= radiusM) return true;
    }
    return false;
  };

  // 2. Pre-screen disciplines & identify candidate Downhill & Inbounds Bootpack nodes
  const downhillCandidates: number[] = [];
  const bootpackCandidates: number[] = [];
  const verifiedInbounds = new Set<number>();
  const coordsByIdx: [number, number, number?][][] = new Array(pisteFeatures.length);
  const lengthByIdx: number[] = new Array(pisteFeatures.length);
  const minZByIdx: number[] = new Array(pisteFeatures.length);
  const maxZByIdx: number[] = new Array(pisteFeatures.length);
  const bottomPtByIdx: [number, number][] = new Array(pisteFeatures.length);
  const returnCheckPtsByIdx: [number, number, number?][][] = new Array(pisteFeatures.length);
  const entryCheckPtsByIdx: [number, number, number?][][] = new Array(pisteFeatures.length);

  for (let i = 0; i < pisteFeatures.length; i++) {
    const feat = pisteFeatures[i];
    const props = feat.properties || {};
    const geomType = feat.geometry?.type;
    const isPoly = geomType === 'Polygon' || geomType === 'MultiPolygon';

    const coords = extractFlatCoords(feat.geometry);
    coordsByIdx[i] = coords;
    lengthByIdx[i] = computeLineLengthMeters(coords);

    let minZ = Infinity;
    let maxZ = -Infinity;
    let bPt: [number, number] = coords.length > 0 ? [coords[coords.length - 1][0], coords[coords.length - 1][1]] : [0, 0];
    let tPt: [number, number, number?] = coords.length > 0 ? coords[0] : [0, 0, undefined];
    for (const c of coords) {
      if (c.length >= 3 && typeof c[2] === 'number' && isFinite(c[2])) {
        if (c[2] < minZ) {
          minZ = c[2];
          bPt = [c[0], c[1]];
        }
        if (c[2] > maxZ) {
          maxZ = c[2];
          tPt = c;
        }
      }
    }
    minZByIdx[i] = minZ;
    maxZByIdx[i] = maxZ;
    bottomPtByIdx[i] = bPt;

    const hasElevation = isFinite(minZ) && isFinite(maxZ) && maxZ > minZ;
    const vertDrop = hasElevation ? maxZ - minZ : 0;
    // For Polygons, `lengthByIdx` is closed circumference (~2-4x fall-line length); measure fall-line between top & bottom
    const slopeRunMeters = isPoly
      ? Math.max(10, fastDistMeters(tPt[0], tPt[1], bPt[0], bPt[1]))
      : lengthByIdx[i];
    const avgSlopeDeg = hasElevation && slopeRunMeters > 10
      ? (Math.atan2(vertDrop, slopeRunMeters) * 180) / Math.PI
      : 15;

    // Build multi-vertex return & entry check sets (fixes single-vertex Polygon bowl demotions)
    if (isPoly && coords.length > 0) {
      const lowerZCap = hasElevation ? minZ + 0.35 * (maxZ - minZ) : Infinity;
      const lowerRaw = hasElevation
        ? coords.filter(c => typeof c[2] === 'number' && isFinite(c[2]) && c[2]! <= lowerZCap)
        : coords;
      const retSrc = lowerRaw.length > 0 ? lowerRaw : coords;
      const retStep = retSrc.length > 36 ? Math.ceil(retSrc.length / 36) : 1;
      const retPts: [number, number, number?][] = [];
      for (let k = 0; k < retSrc.length; k += retStep) retPts.push(retSrc[k]);
      returnCheckPtsByIdx[i] = retPts;

      const entStep = coords.length > 36 ? Math.ceil(coords.length / 36) : 1;
      const entPts: [number, number, number?][] = [];
      for (let k = 0; k < coords.length; k += entStep) entPts.push(coords[k]);
      const cent = computeCentroid(coords);
      entPts.push([cent[0], cent[1], hasElevation ? (minZ + maxZ) * 0.5 : undefined]);
      entryCheckPtsByIdx[i] = entPts;
    } else if (coords.length > 0) {
      const last = coords[coords.length - 1];
      const retPts: [number, number, number?][] = [[bPt[0], bPt[1], isFinite(minZ) ? minZ : undefined]];
      if (fastDistMeters(bPt[0], bPt[1], last[0], last[1]) > 25) {
        retPts.push(last);
      }
      returnCheckPtsByIdx[i] = retPts;

      const first = coords[0];
      const entPts: [number, number, number?][] = [tPt];
      if (fastDistMeters(tPt[0], tPt[1], first[0], first[1]) > 25) {
        entPts.push(first);
      }
      entryCheckPtsByIdx[i] = entPts;
    } else {
      returnCheckPtsByIdx[i] = [];
      entryCheckPtsByIdx[i] = [];
    }

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
    const diff = String(props.difficulty || props['piste:difficulty'] || '').toLowerCase();

    // Exclude dedicated snowshoe loops mis-tagged as downhill pistes
    if (/\bsnowshoe\b/i.test(name) && !types.has('nordic')) {
      props.atlas_category = 'ignore';
      continue;
    }

    // TIER 2A: Strict Nordic Isolation
    if (types.has('nordic') && !types.has('downhill') && !types.has('freeride')) {
      if (!name && ['track', 'service', 'footway', 'path'].includes(highway) && lengthByIdx[i] < 400) {
        props.atlas_category = 'ignore';
      } else {
        props.atlas_category = 'nordic';
      }
      continue;
    }

    // Explicit out-of-bounds patrol tag goes straight to touring
    if (patrolled === 'no') {
      props.atlas_category = 'touring';
      continue;
    }

    // TIER 2B: Ski Touring vs. Inbounds Hike-To Bootpacks / Traverses
    // OSM mappers tag inbounds resort bootpacks & sidesteps (e.g. Mary's Nipple Traverse,
    // Blackcomb Bench Climb / Spanky's Ladder, Gunsight Sidestep, Jupiter Peak) as `piste:type=skitour`.
    if (types.has('skitour') && !types.has('downhill') && !types.has('freeride')) {
      if (!name && ['track', 'service', 'unclassified', 'residential'].includes(highway) && lengthByIdx[i] < 350) {
        props.atlas_category = 'ignore';
        continue;
      }
      if (winterSportsPolygons.length > 0 && lengthByIdx[i] <= 2500) {
        const midCoord = coords.length > 0 ? coords[Math.floor(coords.length / 2)] : null;
        if (midCoord && winterSportsPolygons.some(poly => pointInPolygonGeom(midCoord[0], midCoord[1], poly.geometry))) {
          props.atlas_category = 'downhill';
          verifiedInbounds.add(i);
          downhillCandidates.push(i);
          continue;
        }
      }
      const isBoundedBootpack =
        liftPoints.length > 0 &&
        lengthByIdx[i] <= 2400 &&
        (!hasElevation || vertDrop <= 400) &&
        coords.some(([lng, lat]) => isPointWithinMetersOfLift(lng, lat, 850));

      if (isBoundedBootpack) {
        bootpackCandidates.push(i);
      } else {
        props.atlas_category = 'touring';
      }
      continue;
    }

    // Ignore non-ski paths (winter_hike, hike, sled, snowshoe, fatbike) unless tagged downhill/freeride/connection
    if (!types.has('downhill') && !types.has('freeride') && !types.has('connection')) {
      props.atlas_category = 'ignore';
      continue;
    }

    // Summer hiking trails masquerading as pistes (highway=path/footway with no grooming & sharp switchbacks)
    if (['path', 'footway', 'track', 'bridleway'].includes(highway) && !grooming) {
      const switchbacks = countHairpinSwitchbacks(coords);
      if (switchbacks >= 3) {
        props.atlas_category = 'ignore';
        continue;
      }
    }

    // UNIVERSAL PHYSICAL GRADIENT LAW (Slope & Energy Law)
    const isMachineGroomed = ['classic', 'skating', 'scooter'].includes(grooming);
    const isEasyGrade = diff === 'novice' || diff === 'easy';
    const isBadGrooming = grooming === 'backcountry' || grooming === 'no';
    const isMissingGroomWithBadHighway = !grooming && ['path', 'footway', 'track'].includes(highway) && !isEasyGrade;
    const shouldRejectLowGradient = !isMachineGroomed && (isBadGrooming || isMissingGroomWithBadHighway);

    if (!isPoly && hasElevation && lengthByIdx[i] >= 1200 && avgSlopeDeg <= 4.5 && shouldRejectLowGradient) {
      if (types.has('skitour')) {
        props.atlas_category = 'touring';
      } else if (['track', 'service', 'path', 'footway', 'unclassified'].includes(highway) || !isRealName(name) || diff === 'freeride') {
        props.atlas_category = 'ignore';
      } else {
        props.atlas_category = 'touring';
      }
      continue;
    }

    // Boundary Polygon Check: features inside landuse=winter_sports are verified inbounds downhill
    if (winterSportsPolygons.length > 0 && (types.has('downhill') || types.has('freeride'))) {
      const midCoord = coords.length > 0 ? coords[Math.floor(coords.length / 2)] : null;
      if (midCoord && winterSportsPolygons.some(poly => pointInPolygonGeom(midCoord[0], midCoord[1], poly.geometry))) {
        props.atlas_category = 'downhill';
        verifiedInbounds.add(i);
        downhillCandidates.push(i);
        continue;
      }
    }

    downhillCandidates.push(i);
  }

  // 3. Build Spatial Adjacency & Apron Runout Grids for Downhill Candidates
  const gridMap = new Map<string, number[]>();
  const apronGridMap = new Map<string, ApronSample[]>();
  const nameMap = new Map<string, number[]>();

  const addToGrid = (lng: number, lat: number, idx: number) => {
    const key = cellKey(lng, lat);
    let list = gridMap.get(key);
    if (!list) {
      list = [];
      gridMap.set(key, list);
    }
    list.push(idx);
  };

  const addToApronGrid = (lng: number, lat: number, z: number | undefined, idx: number) => {
    const key = apronCellKey(lng, lat);
    let list = apronGridMap.get(key);
    if (!list) {
      list = [];
      apronGridMap.set(key, list);
    }
    list.push({ lng, lat, z, idx });
  };

  for (const idx of downhillCandidates) {
    const coords = coordsByIdx[idx];
    if (coords.length === 0) continue;

    const geomType = pisteFeatures[idx].geometry?.type;
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      for (let k = 0; k < coords.length; k++) {
        const [lng, lat, z] = coords[k];
        addToGrid(lng, lat, idx);
        addToApronGrid(lng, lat, z, idx);
        if (k > 0) {
          const [px, py, pz] = coords[k - 1];
          const segDist = fastDistMeters(px, py, lng, lat);
          const steps = Math.floor(segDist / 35);
          for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const ix = px + (lng - px) * t;
            const iy = py + (lat - py) * t;
            const iz = typeof pz === 'number' && typeof z === 'number' ? pz + (z - pz) * t : z;
            addToGrid(ix, iy, idx);
            addToApronGrid(ix, iy, iz, idx);
          }
        }
      }
      const centroid = computeCentroid(coords);
      addToGrid(centroid[0], centroid[1], idx);
    } else {
      const sampleIndices = new Set<number>([0, coords.length - 1]);
      for (let k = 0; k < coords.length; k += 4) sampleIndices.add(k);
      for (const k of sampleIndices) {
        const c = coords[k];
        addToGrid(c[0], c[1], idx);
        addToApronGrid(c[0], c[1], c[2], idx);
      }
    }

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

  // 4. PASS 1: Forward `liftServed` BFS from upper lift stations / upper 70% of lift span
  const liftServed = new Set<number>();
  const queue: { idx: number; dist: number }[] = [];

  for (const idx of verifiedInbounds) {
    liftServed.add(idx);
    queue.push({ idx, dist: 0 });
  }

  if (liftPoints.length === 0) {
    for (const idx of downhillCandidates) {
      if (!liftServed.has(idx)) {
        liftServed.add(idx);
        queue.push({ idx, dist: 0 });
      }
    }
  } else {
    for (const idx of downhillCandidates) {
      if (liftServed.has(idx)) continue;
      const coords = coordsByIdx[idx];
      const touchesLift = coords.some(([lng, lat]) => isPointWithinMetersOfUpperLift(lng, lat, 350));
      if (touchesLift) {
        liftServed.add(idx);
        queue.push({ idx, dist: 0 });
      }
    }
  }

  const MAX_CHAIN_METERS = 8000;
  while (queue.length > 0) {
    const { idx, dist } = queue.shift()!;
    const coords = coordsByIdx[idx];
    const neighbors = new Set<number>();

    const geomType = pisteFeatures[idx].geometry?.type;
    let checkPoints: [number, number][];
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      const step = coords.length > 30 ? Math.ceil(coords.length / 30) : 1;
      checkPoints = [];
      for (let k = 0; k < coords.length; k += step) {
        checkPoints.push([coords[k][0], coords[k][1]]);
      }
      checkPoints.push(computeCentroid(coords));
    } else {
      checkPoints = [
        [coords[0][0], coords[0][1]],
        [coords[coords.length - 1][0], coords[coords.length - 1][1]],
        [coords[Math.floor(coords.length / 2)][0], coords[Math.floor(coords.length / 2)][1]],
      ];
      if (coords.length > 20) {
        for (let k = 5; k < coords.length - 1; k += 10) {
          checkPoints.push([coords[k][0], coords[k][1]]);
        }
      }
    }

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
        const myCoords = coordsByIdx[idx];
        const myStart = myCoords[0];
        const myEnd = myCoords[myCoords.length - 1];
        for (const nIdx of sameName) {
          if (nIdx === idx) continue;
          const nCoords = coordsByIdx[nIdx];
          if (nCoords && nCoords.length > 0) {
            const nStart = nCoords[0];
            const nEnd = nCoords[nCoords.length - 1];
            const minDist = Math.min(
              fastDistMeters(myStart[0], myStart[1], nStart[0], nStart[1]),
              fastDistMeters(myStart[0], myStart[1], nEnd[0], nEnd[1]),
              fastDistMeters(myEnd[0], myEnd[1], nStart[0], nStart[1]),
              fastDistMeters(myEnd[0], myEnd[1], nEnd[0], nEnd[1])
            );
            if (minDist <= 150) {
              neighbors.add(nIdx);
            }
          }
        }
      }
    }

    const currentMaxZ = maxZByIdx[idx];
    for (const nIdx of neighbors) {
      if (liftServed.has(nIdx)) continue;
      const nextMinZ = minZByIdx[nIdx];
      if (isFinite(currentMaxZ) && isFinite(nextMinZ) && currentMaxZ > 0 && nextMinZ > 0) {
        if (nextMinZ > currentMaxZ + 15) {
          continue;
        }
      }
      const nextDist = dist + lengthByIdx[nIdx];
      if (nextDist <= MAX_CHAIN_METERS) {
        liftServed.add(nIdx);
        queue.push({ idx: nIdx, dist: nextDist });
      }
    }
  }

  // 5. PASS 2: Backward `canReturnToLift` Gravity-Return Closure
  // Determines whether skiing down a candidate run (including across polygon rims and
  // <= 280m open glacier/bowl aprons) delivers the skier back to an operating lift.
  const canReturnToLift = new Set<number>();

  for (const idx of verifiedInbounds) {
    canReturnToLift.add(idx);
  }

  if (liftPoints.length === 0) {
    for (const idx of downhillCandidates) canReturnToLift.add(idx);
  } else {
    for (const idx of downhillCandidates) {
      if (canReturnToLift.has(idx)) continue;
      const geomType = pisteFeatures[idx].geometry?.type;
      const isPoly = geomType === 'Polygon' || geomType === 'MultiPolygon';
      const retPts = returnCheckPtsByIdx[idx];
      if (retPts.some(([lng, lat]) => isPointWithinMetersOfLift(lng, lat, 350))) {
        canReturnToLift.add(idx);
        continue;
      }
      if (isPoly && coordsByIdx[idx].some(([lng, lat]) => isPointWithinMetersOfLift(lng, lat, 280))) {
        canReturnToLift.add(idx);
      }
    }

    // Fixed-point uphill return propagation (converges in ~4-8 passes)
    let addedReturn = true;
    let guardIter = 0;
    while (addedReturn && guardIter < 14) {
      addedReturn = false;
      guardIter++;
      for (const uIdx of downhillCandidates) {
        if (canReturnToLift.has(uIdx)) continue;
        const retPts = returnCheckPtsByIdx[uIdx];
        const uMinZ = minZByIdx[uIdx];
        const uMaxZ = maxZByIdx[uIdx];
        let connects = false;

        for (const [bx, by, bz] of retPts) {
          // 5A. Direct ~65m junction with a lift-returning run
          for (const nKey of neighborCellKeys(bx, by)) {
            const bucket = gridMap.get(nKey);
            if (!bucket) continue;
            for (const dIdx of bucket) {
              if (dIdx === uIdx || !canReturnToLift.has(dIdx)) continue;
              const dMinZ = minZByIdx[dIdx];
              const refZ = typeof bz === 'number' && isFinite(bz) ? bz : uMinZ;
              if (isFinite(refZ) && isFinite(dMinZ) && refZ > 0 && dMinZ > 0) {
                if (dMinZ > Math.max(refZ + 25, isFinite(uMaxZ) ? uMaxZ + 15 : refZ + 25)) continue;
              }
              connects = true;
              break;
            }
            if (connects) break;
          }
          if (connects) break;

          // 5B. Open Glacier / Bowl Apron Runout Bridge (<= 280m horizontal, 0..140m vertical drop)
          const refZ = typeof bz === 'number' && isFinite(bz) ? bz : uMinZ;
          if (isFinite(refZ) && refZ > 0) {
            for (const aKey of neighborApronCellKeys(bx, by)) {
              const aBucket = apronGridMap.get(aKey);
              if (!aBucket) continue;
              for (const sample of aBucket) {
                if (sample.idx === uIdx || !canReturnToLift.has(sample.idx)) continue;
                if (typeof sample.z !== 'number' || !isFinite(sample.z)) continue;
                // Downstream run vertex must sit level or up to 140m below the bowl/chute apron exit
                if (refZ >= sample.z - 12 && refZ <= sample.z + 140) {
                  if (fastDistMeters(bx, by, sample.lng, sample.lat) <= 280) {
                    connects = true;
                    break;
                  }
                }
              }
              if (connects) break;
            }
          }
          if (connects) break;
        }

        if (connects) {
          canReturnToLift.add(uIdx);
          addedReturn = true;
          continue;
        }

        // 5C. Polygon Interior Containment: if a lift-returning run passes inside a glade/bowl polygon
        const uGeom = pisteFeatures[uIdx].geometry;
        if (uGeom?.type === 'Polygon' || uGeom?.type === 'MultiPolygon') {
          const cent = computeCentroid(coordsByIdx[uIdx]);
          for (const aKey of neighborApronCellKeys(cent[0], cent[1])) {
            const aBucket = apronGridMap.get(aKey);
            if (!aBucket) continue;
            for (const sample of aBucket) {
              if (sample.idx === uIdx || !canReturnToLift.has(sample.idx)) continue;
              if (pointInPolygonGeom(sample.lng, sample.lat, uGeom)) {
                connects = true;
                break;
              }
            }
            if (connects) break;
          }
          if (connects) {
            canReturnToLift.add(uIdx);
            addedReturn = true;
          }
        }
      }
    }
  }

  // 6. PASS 3: Rescue Hike-To Bowls/Ridges & Inbounds Bootpacks (`skitour`)
  // 6A. Any downhill bowl/chute/polygon whose gravity path returns to a lift AND whose top
  //     is within 1,200m of an upper lift (or 85m of a liftServed run) is an inbounds hike-to line
  //     (e.g. Ruby Bowl, Surf's Up, Lakeside Bowl, Symphony Bowl, T2 North Ridge, Powder Assault).
  if (liftPoints.length > 0) {
    let addedHikeBowl = true;
    let bowlIter = 0;
    while (addedHikeBowl && bowlIter < 6) {
      addedHikeBowl = false;
      bowlIter++;
      for (const idx of downhillCandidates) {
        if (liftServed.has(idx) || !canReturnToLift.has(idx)) continue;
        const entPts = entryCheckPtsByIdx[idx];
        const nearUpper = entPts.some(([lng, lat]) => isPointWithinMetersOfUpperLift(lng, lat, 1200));
        const touchesServed = !nearUpper && entPts.some(([lng, lat]) =>
          neighborCellKeys(lng, lat).some(k => (gridMap.get(k) || []).some(nIdx => nIdx !== idx && liftServed.has(nIdx)))
        );
        if (nearUpper || touchesServed) {
          liftServed.add(idx);
          addedHikeBowl = true;
        }
      }
    }
  }

  // 6B. Evaluate candidate inbounds bootpacks / traverses (`piste:type=skitour`):
  //     Rescued to `downhill` ONLY if they bridge from an upper lift / inbounds run into
  //     a lift or a downhill run that gravity-returns to a lift (e.g. Mary's Nipple Traverse,
  //     Watchabe Return, Blackcomb Bench Climb, Gunsight Sidestep, Eddie's Bootpack, Jupiter Peak).
  const rescuedBootpacks = new Set<number>();
  const bootpackChainLen = new Map<number, number>();

  const isPointNearReturnRun = (lng: number, lat: number, radiusM: number): boolean => {
    for (const aKey of neighborApronCellKeys(lng, lat)) {
      const bucket = apronGridMap.get(aKey);
      if (!bucket) continue;
      for (const s of bucket) {
        if (canReturnToLift.has(s.idx) && fastDistMeters(lng, lat, s.lng, s.lat) <= radiusM) {
          return true;
        }
      }
    }
    return false;
  };

  const isPointNearServedReturnRun = (lng: number, lat: number, radiusM: number): boolean => {
    for (const aKey of neighborApronCellKeys(lng, lat)) {
      const bucket = apronGridMap.get(aKey);
      if (!bucket) continue;
      for (const s of bucket) {
        if (liftServed.has(s.idx) && canReturnToLift.has(s.idx) && fastDistMeters(lng, lat, s.lng, s.lat) <= radiusM) {
          return true;
        }
      }
    }
    return false;
  };

  let bootpackChanged = true;
  let bpIter = 0;
  while (bootpackChanged && bpIter < 5) {
    bootpackChanged = false;
    bpIter++;

    for (const bIdx of bootpackCandidates) {
      if (rescuedBootpacks.has(bIdx)) continue;
      const coords = coordsByIdx[bIdx];
      if (coords.length < 2) continue;

      const headCount = Math.max(1, Math.ceil(coords.length * 0.25));
      const tailStart = Math.min(coords.length - 1, Math.floor(coords.length * 0.75));
      const headPts = coords.slice(0, headCount);
      const tailPts = coords.slice(tailStart);

      // Check origin connectivity (upper lift <= 450m, served return run <= 100m, or rescued bootpack <= 80m)
      let priorChain = 0;
      let hasOrigin = headPts.some(([lng, lat]) =>
        isPointWithinMetersOfUpperLift(lng, lat, 450) || isPointNearServedReturnRun(lng, lat, 100)
      );

      if (!hasOrigin) {
        for (const prevIdx of rescuedBootpacks) {
          const prevLen = bootpackChainLen.get(prevIdx) || 0;
          if (prevLen + lengthByIdx[bIdx] > 2600) continue;
          const prevCoords = coordsByIdx[prevIdx];
          const prevEnd = prevCoords[prevCoords.length - 1];
          if (headPts.some(([lng, lat]) => fastDistMeters(lng, lat, prevEnd[0], prevEnd[1]) <= 80)) {
            hasOrigin = true;
            priorChain = prevLen;
            break;
          }
        }
      }
      if (!hasOrigin) continue;

      // Check destination connectivity (directly to a lift <= 150m, or into a lift-returning downhill run <= 150m)
      const hasReturnDest = tailPts.some(([lng, lat]) =>
        isPointWithinMetersOfLift(lng, lat, 150) || isPointNearReturnRun(lng, lat, 150)
      );
      if (!hasReturnDest) continue;

      rescuedBootpacks.add(bIdx);
      bootpackChainLen.set(bIdx, priorChain + lengthByIdx[bIdx]);
      bootpackChanged = true;

      // Promote any lift-returning downhill chutes/runs fed by this rescued bootpack
      for (const dIdx of downhillCandidates) {
        if (liftServed.has(dIdx) || !canReturnToLift.has(dIdx)) continue;
        const entPts = entryCheckPtsByIdx[dIdx];
        const fedByBootpack = entPts.some(([ex, ey]) =>
          coords.some(([bx, by]) => fastDistMeters(ex, ey, bx, by) <= 150)
        );
        if (fedByBootpack) {
          liftServed.add(dIdx);
        }
      }
    }
  }

  // Assign final categories to bootpack candidates
  for (const bIdx of bootpackCandidates) {
    pisteFeatures[bIdx].properties.atlas_category = rescuedBootpacks.has(bIdx) ? 'downhill' : 'touring';
  }

  // 7. Assign final categories to downhill candidates + Universal Gravity Sink Law
  for (const idx of downhillCandidates) {
    if (verifiedInbounds.has(idx)) {
      pisteFeatures[idx].properties.atlas_category = 'downhill';
      continue;
    }

    const props = pisteFeatures[idx].properties || {};
    const highway = String(props.highway || '').toLowerCase();
    const grooming = String(props['piste:grooming'] || props.grooming || '').toLowerCase();
    const diff = String(props.difficulty || props['piste:difficulty'] || '').toLowerCase();

    if (!liftServed.has(idx)) {
      pisteFeatures[idx].properties.atlas_category = 'touring';
      continue;
    }

    if (!canReturnToLift.has(idx)) {
      if (
        grooming === 'backcountry' ||
        ['path', 'footway', 'track'].includes(highway) ||
        !isRealName(props.name) ||
        ['freeride', 'expert', 'extreme'].includes(diff)
      ) {
        pisteFeatures[idx].properties.atlas_category = 'touring';
        continue;
      }
    }

    pisteFeatures[idx].properties.atlas_category = 'downhill';
  }

  return pisteFeatures;
}
