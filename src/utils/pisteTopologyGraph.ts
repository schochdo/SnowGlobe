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
  // Filter out micro-vertices closer than 10m so GPS jitter doesn't look like a switchback
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

// Compute centroid of coordinates
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

// Widen downhill junction snapping to ±3 cells (~65m) to bridge cliff bands and minor mapper gaps
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

  // 2. Pre-screen disciplines & identify candidate Downhill graph nodes
  const downhillCandidates: number[] = [];
  const verifiedInbounds = new Set<number>();
  const coordsByIdx: [number, number, number?][][] = new Array(pisteFeatures.length);
  const lengthByIdx: number[] = new Array(pisteFeatures.length);
  const minZByIdx: number[] = new Array(pisteFeatures.length);
  const maxZByIdx: number[] = new Array(pisteFeatures.length);
  const bottomPtByIdx: [number, number][] = new Array(pisteFeatures.length);

  for (let i = 0; i < pisteFeatures.length; i++) {
    const feat = pisteFeatures[i];
    const props = feat.properties || {};

    const coords = extractFlatCoords(feat.geometry);
    coordsByIdx[i] = coords;
    lengthByIdx[i] = computeLineLengthMeters(coords);

    // Analyze elevation profile (3D coords [lng, lat, ele])
    let minZ = Infinity;
    let maxZ = -Infinity;
    let bPt: [number, number] = coords.length > 0 ? [coords[coords.length - 1][0], coords[coords.length - 1][1]] : [0, 0];
    for (const c of coords) {
      if (c.length >= 3 && typeof c[2] === 'number' && isFinite(c[2])) {
        if (c[2] < minZ) {
          minZ = c[2];
          bPt = [c[0], c[1]];
        }
        if (c[2] > maxZ) {
          maxZ = c[2];
        }
      }
    }
    minZByIdx[i] = minZ;
    maxZByIdx[i] = maxZ;
    bottomPtByIdx[i] = bPt;

    const hasElevation = isFinite(minZ) && isFinite(maxZ) && maxZ > minZ;
    const vertDrop = hasElevation ? maxZ - minZ : 0;
    const avgSlopeDeg = hasElevation && lengthByIdx[i] > 10
      ? (Math.atan2(vertDrop, lengthByIdx[i]) * 180) / Math.PI
      : 15;

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

    // UNIVERSAL PHYSICAL GRADIENT LAW (Slope & Energy Law):
    // A downhill ski run requires gravity to overcome friction. Machine-groomed snow (classic, skating, scooter) on flat terrain is Nordic.
    // Long trails (>=1,200m) with average pitch <= 4.5 deg (<8% grade) that lack machine grooming cannot physically sustain downhill skiing.
    // Untagged resort ski-outs (novice/easy difficulty) are protected unless explicitly tagged backcountry/no grooming.
    const isMachineGroomed = ['classic', 'skating', 'scooter'].includes(grooming);
    const isEasyGrade = diff === 'novice' || diff === 'easy';
    const isBadGrooming = grooming === 'backcountry' || grooming === 'no';
    const isMissingGroomWithBadHighway = !grooming && ['path', 'footway', 'track'].includes(highway) && !isEasyGrade;
    const shouldRejectLowGradient = !isMachineGroomed && (isBadGrooming || isMissingGroomWithBadHighway);

    if (hasElevation && lengthByIdx[i] >= 1200 && avgSlopeDeg <= 4.5 && shouldRejectLowGradient) {
      if (types.has('skitour')) {
        props.atlas_category = 'touring';
      } else if (['track', 'service', 'path', 'footway', 'unclassified'].includes(highway) || !isRealName(name) || diff === 'freeride') {
        props.atlas_category = 'ignore';
      } else {
        props.atlas_category = 'touring';
      }
      continue;
    }

    // Boundary Polygon Check: If feature lies inside a landuse=winter_sports polygon,
    // it is inbounds downhill terrain by definition.
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

  // 3. TIER 1: Build Spatial Adjacency Graph for Downhill Candidates
  const gridMap = new Map<string, number[]>();
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

  for (const idx of downhillCandidates) {
    const coords = coordsByIdx[idx];
    if (coords.length === 0) continue;

    const geomType = pisteFeatures[idx].geometry?.type;
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      // Index all perimeter vertices for polygons/bowls/glades
      for (const [lng, lat] of coords) {
        addToGrid(lng, lat, idx);
      }
      // Also index centroid
      const centroid = computeCentroid(coords);
      addToGrid(centroid[0], centroid[1], idx);
    } else {
      // Index start, end, and every 5th vertex for line strings
      const sampleIndices = new Set<number>([0, coords.length - 1]);
      for (let k = 0; k < coords.length; k += 5) sampleIndices.add(k);
      for (const k of sampleIndices) {
        addToGrid(coords[k][0], coords[k][1], idx);
      }
    }

    // Also index by normalized trail name within the same resort
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

  // 4. Seed BFS with all downhill segments within 350m of upper lift station / upper 70% of lift span
  const liftServed = new Set<number>();
  const queue: { idx: number; dist: number }[] = [];

  // Features verified inbounds by winter_sports polygon are automatic seeds
  for (const idx of verifiedInbounds) {
    liftServed.add(idx);
    queue.push({ idx, dist: 0 });
  }

  if (liftPoints.length === 0) {
    // Fallback if dataset has no aerialway features loaded yet
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

  // 5. Propagate `liftServed` across connected downhill segments up to 8,000m chain distance
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

    // Name-graph bridging: require nearest endpoints to be <= 150m
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

      // Downhill elevation monotonicity: prevent valley base runs from propagating uphill to un-lifted summits
      const nextMinZ = minZByIdx[nIdx];
      if (isFinite(currentMaxZ) && isFinite(nextMinZ) && currentMaxZ > 0 && nextMinZ > 0) {
        if (nextMinZ > currentMaxZ + 15) {
          continue; // Uphill jump exceeds 15m tolerance
        }
      }

      const nextDist = dist + lengthByIdx[nIdx];
      if (nextDist <= MAX_CHAIN_METERS) {
        liftServed.add(nIdx);
        queue.push({ idx: nIdx, dist: nextDist });
      }
    }
  }

  // 6. Finalize Downhill vs. Backcountry Touring + Universal Gravity Sink Law
  for (const idx of downhillCandidates) {
    if (verifiedInbounds.has(idx)) {
      pisteFeatures[idx].properties.atlas_category = 'downhill';
      continue;
    }

    const feat = pisteFeatures[idx];
    const props = feat.properties || {};
    const coords = coordsByIdx[idx];
    const highway = String(props.highway || '').toLowerCase();
    const grooming = String(props['piste:grooming'] || props.grooming || '').toLowerCase();
    const diff = String(props.difficulty || props['piste:difficulty'] || '').toLowerCase();

    if (!liftServed.has(idx)) {
      // Protect inbounds hike-to bowls & ridge runs:
      // If the run's upper terminus is within 900m of an upper lift station AND its bottom terminus
      // delivers the skier back into a lift-served downhill run (within ~85m) or directly to a lift (<=350m),
      // it is an inbounds hike-to line (e.g., Highland Bowl, Headwall, Chamonix Grands Montets bowls),
      // NOT an unserviced backcountry Gravity Sink.
      if (coords.length >= 2 && liftPoints.length > 0) {
        const bPt = bottomPtByIdx[idx] || coords[coords.length - 1];
        const tPt = coords[0];
        const upperNearLift = isPointWithinMetersOfUpperLift(tPt[0], tPt[1], 900);
        if (upperNearLift) {
          const bottomNearLift = isPointWithinMetersOfLift(bPt[0], bPt[1], 350);
          const feedsLiftServedRun =
            bottomNearLift ||
            neighborCellKeys(bPt[0], bPt[1])
              .flatMap(k => gridMap.get(k) || [])
              .some(nIdx => nIdx !== idx && liftServed.has(nIdx));
          if (feedsLiftServedRun) {
            props.atlas_category = 'downhill';
            continue;
          }
        }
      }
      props.atlas_category = 'touring';
      continue;
    }

    // GRAVITY SINK LAW (Lift Gravity Return Loop):
    // An inbounds downhill piste delivers skiers to a lift (either directly at its lowest terminus or via
    // connecting downhill runs). If a run's lowest terminus (where gravity brings the skier) has no lift
    // within 350m and connects to no run with a lift, it drops into an unserviced backcountry drainage/canyon
    // (e.g. Shuksan Arm / Blueberry Chutes at Mt. Baker). The skier cannot ride a lift back up and must skin
    // or hike out => Backcountry / Touring!
    if (coords.length >= 2 && liftPoints.length > 0) {
      const bPt = bottomPtByIdx[idx] || coords[coords.length - 1];
      const bottomNearLift = isPointWithinMetersOfLift(bPt[0], bPt[1], 350);

      if (!bottomNearLift) {
        const bottomNeighbors = neighborCellKeys(bPt[0], bPt[1])
          .flatMap(k => gridMap.get(k) || [])
          .filter(nIdx => nIdx !== idx && liftServed.has(nIdx));

        if (bottomNeighbors.length === 0) {
          if (grooming === 'backcountry' || ['path', 'footway', 'track'].includes(highway) || !isRealName(props.name) || diff === 'freeride') {
            props.atlas_category = 'touring';
            continue;
          }
        }
      }
    }

    props.atlas_category = 'downhill';
  }

  return pisteFeatures;
}
