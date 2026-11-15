#!/usr/bin/env node

/**
 * scripts/verify_topology_canary.cjs
 *
 * Fast CLI verification script for Piste Topology Graph classification.
 * Loads 7 representative resort JSONs from public/data/trails/, strips any
 * pre-baked `atlas_category`, runs `classifySkiAreaTopology`, prints a concise
 * pass/fail summary table of category counts, and asserts known edge cases.
 */

const fs = require('fs');
const path = require('path');
const { classifySkiAreaTopology } = require('../data_pipeline/pisteTopologyGraph.cjs');

// 1. Target representative resorts
const TEST_RESORTS = [
  { id: 'mt-baker', file: 'public/data/trails/mt-baker.json', label: 'Mt. Baker' },
  { id: 'jackson-hole', file: 'public/data/trails/jackson-hole.json', label: 'Jackson Hole' },
  { id: 'queyras-haut-guil', file: 'public/data/trails/534530805814dea3640ab85f879f4d122fec8aac.json', label: 'Queyras (Abriès/Valpreveyre)' },
  { id: 'levi', file: 'public/data/trails/6ff3d800655f463f2ea8d24980630b01000c8c49.json', label: 'Levi (Kittilä)' },
  { id: 'whistler-blackcomb', file: 'public/data/trails/whistler-blackcomb.json', label: 'Whistler Blackcomb' },
  { id: 'chamonix', file: 'public/data/trails/chamonix.json', label: 'Chamonix Mont-Blanc' },
  { id: 'zermatt', file: 'public/data/trails/zermatt.json', label: 'Zermatt / Matterhorn' },
];

console.log('='.repeat(78));
console.log('  PISTE TOPOLOGY GRAPH — CANARY VERIFICATION SUITE');
console.log('='.repeat(78));

const tableRows = [];
const failures = [];

// Track specific edge case assertions
const edgeAssertions = {
  bakerBlueberryChutesTouring: false,
  jackson41MiPathIgnored: false,
  queyrasValpreveyreDownhill: false,
  whistlerCatwalksDownhill: false,
  leviBaseTracksNordic: false,
};

// Raw un-pruned 4.1-mile Jackson Hole summer hiking path (id: 548d46ed)
// Tested as an unclassified input to verify Universal Physical Gradient Law filters it to 'ignore'
const JACKSON_4_1MI_RAW_FEATURE = {
  type: 'Feature',
  id: '548d46ede0ecb638149da6b7f45aab8c217d3707',
  geometry: {
    type: 'LineString',
    coordinates: [
      [-110.8543672, 43.6159534, 2290.9],
      [-110.8500143, 43.6160075, 2281.6],
      [-110.8470851, 43.6156006, 2267.8],
      [-110.8464945, 43.6155225, 2260.7],
      [-110.8460301, 43.6155302, 2256.2],
      [-110.8456731, 43.6155845, 2253.1],
      [-110.8447814, 43.6159534, 2244.6],
      [-110.8441398, 43.6162327, 2237.9],
      [-110.8436577, 43.6163335, 2235.1],
      [-110.8427479, 43.6160385, 2236.4],
      [-110.8415703, 43.6153714, 2237.3],
      [-110.8407499, 43.614836, 2237.5],
      [-110.8400007, 43.6142774, 2236.4],
      [-110.8392158, 43.6135869, 2232.8],
      [-110.8385379, 43.612842, 2228.9],
      [-110.8380383, 43.6120196, 2225],
      [-110.8377172, 43.6111195, 2220.3],
      [-110.8375031, 43.6102194, 2216.5],
      [-110.8373247, 43.6092804, 2211.5],
      [-110.8371106, 43.6083104, 2206.1],
      [-110.8368965, 43.6073714, 2200.7],
      [-110.8366467, 43.6063469, 2195.4],
      [-110.8363613, 43.6053846, 2190.1],
      [-110.8360401, 43.6043834, 2184.8],
      [-110.8357547, 43.6034133, 2179.5],
      [-110.8354692, 43.6024198, 2174.2],
      [-110.8351481, 43.6014575, 2169.1],
      [-110.834827, 43.6004951, 2163.7],
      [-110.8345415, 43.5995328, 2158.4],
      [-110.8342561, 43.5985705, 2153.1],
      [-110.8339706, 43.5976082, 2147.8],
      [-110.8336852, 43.5966458, 2142.5],
      [-110.8333997, 43.5956835, 2137.2],
      [-110.8331143, 43.5947212, 2131.9],
      [-110.8328288, 43.5937588, 2126.6],
      [-110.8325434, 43.5927965, 2121.3],
      [-110.8322579, 43.5918342, 2116],
      [-110.8319725, 43.5908718, 2110.7],
      [-110.831687, 43.5899095, 2105.4],
      [-110.8314016, 43.5889472, 2100.1],
      [-110.8311161, 43.5879848, 2094.8],
      [-110.8308307, 43.5870225, 2089.5],
      [-110.8305452, 43.5860602, 2084.2],
      [-110.8302598, 43.5850978, 2078.9],
      [-110.8299743, 43.5841355, 2073.6],
      [-110.8296889, 43.5831732, 2068.3],
      [-110.8294034, 43.5822108, 2063],
      [-110.829118, 43.5812485, 2057.7],
      [-110.8288325, 43.5802862, 2052.4],
      [-110.8285471, 43.5793238, 2047.1],
      [-110.8280987, 43.5918916, 1969.2]
    ]
  },
  properties: {
    id: '548d46ede0ecb638149da6b7f45aab8c217d3707',
    kind: 'piste',
    name: 'Unnamed Trail',
    difficulty: 'freeride',
    'piste:type': 'downhill',
    'piste:difficulty': 'freeride',
    uses: ['downhill'],
    grooming: 'backcountry',
    gladed: null
  }
};

for (const resort of TEST_RESORTS) {
  const filePath = path.resolve(__dirname, '..', resort.file);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing trail file: ${resort.file}`);
    continue;
  }

  const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const originalFeatures = rawData.features || [];

  const rawPistes = originalFeatures.filter(f => f.properties?.kind === 'piste');
  const lifts = originalFeatures.filter(f => f.properties?.kind === 'lift' || f.properties?.kind === 'aerialway');

  // Deep clone and completely strip any pre-baked atlas_category
  const clonedPistes = JSON.parse(JSON.stringify(rawPistes));
  for (const p of clonedPistes) {
    delete p.properties.atlas_category;
  }

  // Inject raw Jackson Hole 4.1-mi path into Jackson Hole test run to verify Universal Gradient Law
  if (resort.id === 'jackson-hole') {
    clonedPistes.push(JSON.parse(JSON.stringify(JACKSON_4_1MI_RAW_FEATURE)));
  }

  // Run canonical classifier
  classifySkiAreaTopology(clonedPistes, lifts);

  // Aggregate category counts
  const counts = { downhill: 0, nordic: 0, touring: 0, ignore: 0 };
  for (const p of clonedPistes) {
    const cat = p.properties.atlas_category || 'undefined';
    counts[cat] = (counts[cat] || 0) + 1;
  }

  // Run Resort-Specific Assertions
  if (resort.id === 'mt-baker') {
    const blueberryChutes = clonedPistes.find(p => p.properties?.name === 'Blueberry Chutes');
    if (blueberryChutes && blueberryChutes.properties.atlas_category === 'touring') {
      edgeAssertions.bakerBlueberryChutesTouring = true;
    } else {
      failures.push(`Mt. Baker: Blueberry Chutes expected 'touring', got '${blueberryChutes?.properties?.atlas_category}'`);
    }
  }

  if (resort.id === 'jackson-hole') {
    const jackson41 = clonedPistes.find(p => p.id === '548d46ede0ecb638149da6b7f45aab8c217d3707');
    if (jackson41 && jackson41.properties.atlas_category === 'ignore') {
      edgeAssertions.jackson41MiPathIgnored = true;
    } else {
      failures.push(`Jackson Hole: 4.1-mi path expected 'ignore', got '${jackson41?.properties?.atlas_category}'`);
    }
  }

  if (resort.id === 'queyras-haut-guil') {
    const valpreveyreRuns = clonedPistes.filter(p => p.properties?.name === 'Valpreveyre');
    const allDownhill = valpreveyreRuns.length > 0 && valpreveyreRuns.every(p => p.properties.atlas_category === 'downhill');
    if (allDownhill) {
      edgeAssertions.queyrasValpreveyreDownhill = true;
    } else {
      failures.push(`Queyras: Valpreveyre expected all 'downhill', got ${JSON.stringify(valpreveyreRuns.map(r => r.properties.atlas_category))}`);
    }
  }

  if (resort.id === 'whistler-blackcomb') {
    const catwalkNames = ['expressway', 'lower cat track', 'peak traverse', 'yellow brick road', "pika's traverse"];
    const catwalkRuns = clonedPistes.filter(p => {
      const n = (p.properties?.name || '').toLowerCase();
      return catwalkNames.some(cn => n.includes(cn));
    });
    const mostlyDownhill = catwalkRuns.length >= 10 && catwalkRuns.filter(p => p.properties.atlas_category === 'downhill').length >= catwalkRuns.length * 0.8;
    if (mostlyDownhill) {
      edgeAssertions.whistlerCatwalksDownhill = true;
    } else {
      failures.push(`Whistler: Expected flat catwalks/traverses to be 'downhill', found non-downhill items`);
    }
  }

  if (resort.id === 'levi') {
    const baseNordic = clonedPistes.filter(p => p.properties.atlas_category === 'nordic');
    if (baseNordic.length >= 40) {
      edgeAssertions.leviBaseTracksNordic = true;
    } else {
      failures.push(`Levi: Expected >= 40 nordic base tracks, got ${baseNordic.length}`);
    }
  }

  tableRows.push({
    Resort: resort.label,
    Downhill: counts.downhill,
    Nordic: counts.nordic,
    Touring: counts.touring,
    Ignore: counts.ignore,
    Total: clonedPistes.length,
  });
}

// Print Category Table
console.table(tableRows);

console.log('-'.repeat(78));
console.log('  EDGE CASE ASSERTIONS:');
console.log('-'.repeat(78));

const check = (ok) => ok ? '✓ PASS' : '✗ FAIL';
console.log(`  ${check(edgeAssertions.bakerBlueberryChutesTouring)} : Baker Blueberry Chutes == 'touring' (Gravity Sink Law)`);
console.log(`  ${check(edgeAssertions.jackson41MiPathIgnored)} : Jackson Hole 4.1-mi path == 'ignore' (Physical Gradient Law)`);
console.log(`  ${check(edgeAssertions.queyrasValpreveyreDownhill)} : Queyras Valpreveyre == 'downhill' (1km Spatial Fracture BFS)`);
console.log(`  ${check(edgeAssertions.whistlerCatwalksDownhill)} : Whistler flat catwalks == 'downhill' (Machine Groomed Flow)`);
console.log(`  ${check(edgeAssertions.leviBaseTracksNordic)} : Levi base tracks == 'nordic' (Strict Discipline Segregation)`);

console.log('='.repeat(78));

if (failures.length > 0) {
  console.error(`\nFAILED with ${failures.length} regression(s):`);
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
} else {
  console.log('ALL CANARY TOPOLOGY CHECKS PASSED DETERMINISTICALLY.\n');
  process.exit(0);
}
