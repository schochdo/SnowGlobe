const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const world = require('world-atlas/countries-10m.json');

const cleanNames = {
  'United States of America': 'United States',
  'Dem. Rep. Congo': 'DR Congo',
  'Dominican Rep.': 'Dominican Republic',
  'Central African Rep.': 'Central African Rep.',
  'Bosnia and Herz.': 'Bosnia & Herzegovina',
  'Eq. Guinea': 'Equatorial Guinea',
  'W. Sahara': 'Western Sahara',
  'S. Sudan': 'South Sudan',
  'Solomon Is.': 'Solomon Islands',
  'Marshall Is.': 'Marshall Islands',
  'Russian Federation': 'Russia'
};
const getCleanName = n => cleanNames[n] || n;

function pointInRing(pt, ring) {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeo(pt, geojsonGeom) {
  if (!geojsonGeom) return false;
  if (geojsonGeom.type === 'Polygon') {
    if (!pointInRing(pt, geojsonGeom.coordinates[0])) return false;
    for (let i = 1; i < geojsonGeom.coordinates.length; i++) {
      if (pointInRing(pt, geojsonGeom.coordinates[i])) return false;
    }
    return true;
  } else if (geojsonGeom.type === 'MultiPolygon') {
    for (const poly of geojsonGeom.coordinates) {
      if (pointInRing(pt, poly[0])) {
        let inHole = false;
        for (let i = 1; i < poly.length; i++) {
          if (pointInRing(pt, poly[i])) { inHole = true; break; }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }
  return false;
}

function build() {
  console.log('Building authoritative Natural Earth 10m land boundaries...');
  const countries = world.objects.countries.geometries;
  const polyCache = new Map();
  countries.forEach(c => {
    polyCache.set(c.properties.name, topojson.feature(world, c).geometry);
  });

  const countryFeatures = [];

  for (let i = 0; i < countries.length; i++) {
    for (let j = i + 1; j < countries.length; j++) {
      const c1 = countries[i], c2 = countries[j];
      const n1 = c1.properties.name, n2 = c2.properties.name;
      const mesh = topojson.mesh(world, { type: 'GeometryCollection', geometries: [c1, c2] }, (a, b) => a && b && a !== b);
      if (mesh.coordinates && mesh.coordinates.length > 0) {
        const g1 = polyCache.get(n1);
        const g2 = polyCache.get(n2);

        mesh.coordinates.forEach(line => {
          if (line.length < 2) return;

          let name_left = getCleanName(n1);
          let name_right = getCleanName(n2);

          // Majority vote across up to 15 segment midpoints along the polyline to determine sovereign side
          let votesN1Left = 0;
          let votesN2Left = 0;
          const step = Math.max(1, Math.floor((line.length - 1) / 15));
          for (let k = 0; k < line.length - 1; k += step) {
            const p1 = line[k], p2 = line[k + 1];
            const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
            const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-7) continue;
            // Geographic left normal (-dy, +dx) and right normal (+dy, -dx)
            const nx = -dy / len, ny = dx / len;

            for (const delta of [0.002, 0.008, 0.02]) {
              const ptLeft = [mx + nx * delta, my + ny * delta];
              const ptRight = [mx - nx * delta, my - ny * delta];
              const l1 = pointInGeo(ptLeft, g1), l2 = pointInGeo(ptLeft, g2);
              const r1 = pointInGeo(ptRight, g1), r2 = pointInGeo(ptRight, g2);
              if ((l1 && !l2) || (r2 && !r1)) { votesN1Left++; break; }
              if ((l2 && !l1) || (r1 && !r2)) { votesN2Left++; break; }
            }
          }
          if (votesN2Left > votesN1Left) {
            name_left = getCleanName(n2);
            name_right = getCleanName(n1);
          }

          countryFeatures.push({
            type: 'Feature',
            properties: {
              kind: 'country_border',
              name_left: name_left,
              name_right: name_right
            },
            geometry: {
              type: 'LineString',
              coordinates: line.map(p => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000])
            }
          });
        });
      }
    }
  }

  console.log(`Generated ${countryFeatures.length} continuous international land boundary lines.`);

  // Load existing 581 clean 50m state/province lines
  const existingGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/world_boundaries.geojson'), 'utf8'));
  const stateFeatures = existingGeo.features.filter(f => f.properties && f.properties.kind === 'state_border');
  console.log(`Preserved ${stateFeatures.length} state/province administrative borders.`);

  const finalGeo = {
    type: 'FeatureCollection',
    features: [...countryFeatures, ...stateFeatures]
  };

  const outPath = path.join(__dirname, '../public/data/world_boundaries.geojson');
  fs.writeFileSync(outPath, JSON.stringify(finalGeo));
  console.log(`Successfully wrote ${outPath} (${finalGeo.features.length} total features).`);
}

build();
