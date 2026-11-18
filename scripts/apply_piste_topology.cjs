const fs = require('fs');
const path = require('path');
const { classifySkiAreaTopology } = require('../data_pipeline/pisteTopologyGraph.cjs');

const trailDir = path.join(__dirname, '../public/data/trails');
if (!fs.existsSync(trailDir)) {
  console.error(`Trail directory not found at ${trailDir}`);
  process.exit(1);
}

const files = fs.readdirSync(trailDir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
console.log(`Applying 3-tier topological graph classifier across ${files.length} trail datasets...`);
console.time('apply_topology');

let updatedFiles = 0;
let strippedFeatures = 0;
let totalPistes = 0;
const globalCategoryCounts = {
  downhill: 0,
  nordic: 0,
  touring: 0,
  ignore: 0,
};

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const filePath = path.join(trailDir, file);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.features || !Array.isArray(data.features)) continue;

    const lifts = data.features.filter(f => f.properties?.kind === 'lift' || f.properties?.kind === 'aerialway');
    const pistes = data.features.filter(f => f.properties?.kind === 'piste');
    totalPistes += pistes.length;

    classifySkiAreaTopology(pistes, lifts);

    for (const p of pistes) {
      const cat = p.properties?.atlas_category || 'ignore';
      if (globalCategoryCounts[cat] !== undefined) {
        globalCategoryCounts[cat]++;
      }
    }

    const initialCount = data.features.length;
    data.features = data.features.filter(f => {
      if (f.properties?.kind === 'piste') {
        return f.properties.atlas_category !== 'ignore';
      }
      return true;
    });

    const stripped = initialCount - data.features.length;
    strippedFeatures += stripped;

    // Update metadata properties if present
    if (data.properties) {
      data.properties.feature_count = data.features.length;
      data.properties.pistes = data.features.filter(f => f.properties?.kind === 'piste').length;
    }

    fs.writeFileSync(filePath, JSON.stringify(data));
    updatedFiles++;
  } catch (err) {
    console.error(`Error processing ${file}:`, err.message);
  }

  if ((i + 1) % 1000 === 0 || i + 1 === files.length) {
    console.log(`Processed ${i + 1} / ${files.length} files...`);
  }
}

console.timeEnd('apply_topology');
console.log(`Done! Updated ${updatedFiles} files, classified ${totalPistes} pistes, stripped ${strippedFeatures} ignored features.`);
console.log('Final Global Category Counts:');
console.table(globalCategoryCounts);
