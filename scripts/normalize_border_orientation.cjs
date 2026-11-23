#!/usr/bin/env node
/**
 * normalize_border_orientation.cjs
 *
 * Normalizes every `country_border` feature in public/data/world_boundaries.geojson
 * to run West -> East (dx >= 0). When a segment runs East -> West (dx < 0),
 * MapLibre's `text-keep-upright: true` flips the 2-line `LEFT\nRIGHT` border label
 * 180 degrees, placing country names on the wrong side of the border (e.g., US-Mexico).
 *
 * Reversing coordinates and swapping left/right attributes guarantees `name_left`
 * always renders on the North side and `name_right` on the South side worldwide.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/world_boundaries.geojson');

const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const newFeatures = [];
let flippedCount = 0;

function orientLineString(coords, props) {
  if (!coords || coords.length < 2) {
    return { coords, props: { ...props }, flipped: false };
  }
  const dx = coords[coords.length - 1][0] - coords[0][0];
  const dy = coords[coords.length - 1][1] - coords[0][1];
  const needsFlip = dx < 0 || (Math.abs(dx) < 1e-6 && dy < 0);

  if (!needsFlip) {
    return { coords, props: { ...props }, flipped: false };
  }

  const nextProps = { ...props };
  if ('name_left' in nextProps || 'name_right' in nextProps) {
    const tmp = nextProps.name_left;
    nextProps.name_left = nextProps.name_right;
    nextProps.name_right = tmp;
  }
  if ('adm0_left' in nextProps || 'adm0_right' in nextProps) {
    const tmp = nextProps.adm0_left;
    nextProps.adm0_left = nextProps.adm0_right;
    nextProps.adm0_right = tmp;
  }

  return {
    coords: [...coords].reverse(),
    props: nextProps,
    flipped: true,
  };
}

for (const f of fc.features) {
  if (f.properties?.kind !== 'country_border') {
    newFeatures.push(f);
    continue;
  }

  if (f.geometry?.type === 'LineString') {
    const res = orientLineString(f.geometry.coordinates, f.properties);
    if (res.flipped) flippedCount++;
    newFeatures.push({
      ...f,
      geometry: { type: 'LineString', coordinates: res.coords },
      properties: res.props,
    });
  } else if (f.geometry?.type === 'MultiLineString') {
    for (const line of f.geometry.coordinates) {
      const res = orientLineString(line, f.properties);
      if (res.flipped) flippedCount++;
      newFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: res.coords },
        properties: res.props,
      });
    }
  } else {
    newFeatures.push(f);
  }
}

fc.features = newFeatures;
fs.writeFileSync(DATA_PATH, JSON.stringify(fc));
console.log(`Normalized world_boundaries.geojson: flipped ${flippedCount} East->West border segments to West->East.`);
