#!/usr/bin/env node
/**
 * strip_boilerplate_summaries.cjs
 *
 * Non-destructively strips all remaining Mad-Libs AI boilerplate summary templates
 * from public/data/global_ski_areas.json and removes stray non-resort duplicates
 * (Tuckerman Ravine downhill duplicate & Touring - Refuge Coyote).
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');

const BOILERPLATE_PATTERNS = [
  /offering scenic mountain slopes and winter recreation/i,
  /^Alpine ski destination in /i,
  /^Dedicated cross-country ski center in /i,
  /^Mountain ski destination in /i,
  /^Japanese powder ski area in /i,
  /^Nordic ski destination in /i,
  /^Exclusive private member ski enclave in /i,
  /^Guided deep-powder wilderness operation in /i,
];

const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

let stripped = 0;
let removedStray = 0;

fc.features = fc.features.filter((f) => {
  const p = f.properties || {};
  const nameLower = String(p.name || '').trim().toLowerCase();
  if (nameLower === 'tuckerman ravine' || nameLower === 'touring - refuge coyote') {
    removedStray++;
    return false;
  }
  return true;
});

for (const f of fc.features) {
  const p = f.properties;
  if (!p || !p.summary) continue;
  if (BOILERPLATE_PATTERNS.some((re) => re.test(p.summary))) {
    p.summary = '';
    stripped++;
  }
}

fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
console.log(`Stripped ${stripped} boilerplate summaries and removed ${removedStray} stray non-resort entries.`);
