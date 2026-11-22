#!/usr/bin/env node
/**
 * sanitize_global_ski_areas.cjs
 *
 * Enforces strict data provenance hygiene on public/data/global_ski_areas.json:
 * 1. Applies verified official resort specs for major North American ski areas.
 * 2. Nulls out fabricated/bucketed avg_snowfall_in and unverified polygon-derived
 *    skiable_acres for all non-verified records.
 * 3. Strips generic boilerplate AI summaries.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');

const VERIFIED_RESORT_SPECS = [
  { match: 'mt. bachelor', altMatch: 'mount bachelor', region: 'Oregon', skiable_acres: 4323, vertical_ft: 3365, summit_elev_ft: 9065, base_elev_ft: 5700, avg_snowfall_in: 462, pass_networks: ['Ikon'] },
  { match: 'crystal mountain', region: 'Washington', skiable_acres: 2600, vertical_ft: 3100, summit_elev_ft: 7012, base_elev_ft: 4400, avg_snowfall_in: 486, pass_networks: ['Ikon'] },
  { match: 'stevens pass', region: 'Washington', skiable_acres: 1125, vertical_ft: 1800, summit_elev_ft: 5845, base_elev_ft: 4061, avg_snowfall_in: 460, pass_networks: ['Epic'] },
  { match: 'mt. hood meadows', altMatch: 'mount hood meadows', region: 'Oregon', skiable_acres: 2150, vertical_ft: 2777, summit_elev_ft: 7300, base_elev_ft: 4523, avg_snowfall_in: 430, pass_networks: ['Indy'] },
  { match: 'timberline', region: 'Oregon', skiable_acres: 1685, vertical_ft: 3690, summit_elev_ft: 8540, base_elev_ft: 4850, avg_snowfall_in: 550, pass_networks: ['Independent'] },
  { match: 'whitefish mountain', region: 'Montana', skiable_acres: 3000, vertical_ft: 2353, summit_elev_ft: 6817, base_elev_ft: 4464, avg_snowfall_in: 300, pass_networks: ['Independent'] },
  { match: 'bridger bowl', region: 'Montana', skiable_acres: 2000, vertical_ft: 2600, summit_elev_ft: 8700, base_elev_ft: 6100, avg_snowfall_in: 350, pass_networks: ['Independent'] },
  { match: 'schweitzer', region: 'Idaho', skiable_acres: 2900, vertical_ft: 2400, summit_elev_ft: 6400, base_elev_ft: 4000, avg_snowfall_in: 300, pass_networks: ['Ikon'] },
  { match: 'grand targhee', region: 'Wyoming', skiable_acres: 2602, vertical_ft: 2270, summit_elev_ft: 9862, base_elev_ft: 7592, avg_snowfall_in: 500, pass_networks: ['Mountain Collective'] },
  { match: 'brighton', region: 'Utah', skiable_acres: 1050, vertical_ft: 1875, summit_elev_ft: 10500, base_elev_ft: 8755, avg_snowfall_in: 500, pass_networks: ['Ikon'] },
  { match: 'solitude', region: 'Utah', skiable_acres: 1200, vertical_ft: 2494, summit_elev_ft: 10488, base_elev_ft: 7994, avg_snowfall_in: 500, pass_networks: ['Ikon'] },
  { match: 'deer valley', region: 'Utah', skiable_acres: 2342, vertical_ft: 3000, summit_elev_ft: 9570, base_elev_ft: 6570, avg_snowfall_in: 300, pass_networks: ['Ikon'] },
  { match: 'snowbasin', region: 'Utah', skiable_acres: 3000, vertical_ft: 3000, summit_elev_ft: 9350, base_elev_ft: 6450, avg_snowfall_in: 300, pass_networks: ['Ikon'] },
  { match: 'taos ski valley', region: 'New Mexico', skiable_acres: 1294, vertical_ft: 3281, summit_elev_ft: 12481, base_elev_ft: 9200, avg_snowfall_in: 300, pass_networks: ['Ikon', 'Mountain Collective'] },
  { match: 'wolf creek', region: 'Colorado', skiable_acres: 1600, vertical_ft: 1604, summit_elev_ft: 11904, base_elev_ft: 10300, avg_snowfall_in: 430, pass_networks: ['Independent'] },
  { match: 'loveland ski area', altMatch: 'loveland', region: 'Colorado', skiable_acres: 1800, vertical_ft: 2210, summit_elev_ft: 13010, base_elev_ft: 10800, avg_snowfall_in: 422, pass_networks: ['Indy'] },
  { match: 'monarch mountain', region: 'Colorado', skiable_acres: 800, vertical_ft: 1162, summit_elev_ft: 11952, base_elev_ft: 10790, avg_snowfall_in: 350, pass_networks: ['Indy'] },
  { match: 'crested butte', region: 'Colorado', skiable_acres: 1547, vertical_ft: 3062, summit_elev_ft: 12162, base_elev_ft: 9375, avg_snowfall_in: 236, pass_networks: ['Epic'] },
  { match: 'keystone', region: 'Colorado', skiable_acres: 3148, vertical_ft: 3128, summit_elev_ft: 12408, base_elev_ft: 9280, avg_snowfall_in: 235, pass_networks: ['Epic'] },
  { match: 'beaver creek', region: 'Colorado', skiable_acres: 2082, vertical_ft: 3340, summit_elev_ft: 11440, base_elev_ft: 8100, avg_snowfall_in: 325, pass_networks: ['Epic'] },
  { match: 'winter park', region: 'Colorado', skiable_acres: 3081, vertical_ft: 3060, summit_elev_ft: 12060, base_elev_ft: 9000, avg_snowfall_in: 344, pass_networks: ['Ikon'] },
  { match: 'purgatory', region: 'Colorado', skiable_acres: 1635, vertical_ft: 2029, summit_elev_ft: 10822, base_elev_ft: 8793, avg_snowfall_in: 260, pass_networks: ['Independent'] },
  { match: 'sun peaks', region: 'British Columbia', skiable_acres: 4270, vertical_ft: 2894, summit_elev_ft: 6824, base_elev_ft: 3930, avg_snowfall_in: 237, pass_networks: ['Ikon', 'Mountain Collective'] },
  { match: 'big white', region: 'British Columbia', skiable_acres: 2765, vertical_ft: 2550, summit_elev_ft: 7606, base_elev_ft: 4950, avg_snowfall_in: 295, pass_networks: ['Independent'] },
  { match: 'silverstar', altMatch: 'silver star', region: 'British Columbia', skiable_acres: 3282, vertical_ft: 2500, summit_elev_ft: 6280, base_elev_ft: 3780, avg_snowfall_in: 275, pass_networks: ['Independent'] },
  { match: 'red mountain', region: 'British Columbia', skiable_acres: 3850, vertical_ft: 2919, summit_elev_ft: 6807, base_elev_ft: 3888, avg_snowfall_in: 300, pass_networks: ['Ikon'] },
  { match: 'whitewater', region: 'British Columbia', skiable_acres: 2367, vertical_ft: 2044, summit_elev_ft: 6700, base_elev_ft: 5250, avg_snowfall_in: 472, pass_networks: ['Indy'] },
  { match: 'kicking horse', region: 'British Columbia', skiable_acres: 3486, vertical_ft: 4314, summit_elev_ft: 8218, base_elev_ft: 3904, avg_snowfall_in: 288, pass_networks: ['Epic'] },
  { match: 'fernie alpine', region: 'British Columbia', skiable_acres: 2500, vertical_ft: 3550, summit_elev_ft: 7000, base_elev_ft: 3450, avg_snowfall_in: 360, pass_networks: ['Epic'] },
  { match: 'sunshine village', region: 'Alberta', skiable_acres: 3358, vertical_ft: 3514, summit_elev_ft: 8954, base_elev_ft: 5440, avg_snowfall_in: 360, pass_networks: ['Ikon', 'Mountain Collective'] },
  { match: 'lake louise', region: 'Alberta', skiable_acres: 4200, vertical_ft: 3250, summit_elev_ft: 8650, base_elev_ft: 5400, avg_snowfall_in: 180, pass_networks: ['Ikon', 'Mountain Collective'] },
  { match: 'killington', region: 'Vermont', skiable_acres: 1509, vertical_ft: 3050, summit_elev_ft: 4241, base_elev_ft: 1165, avg_snowfall_in: 250, pass_networks: ['Ikon'] },
  { match: 'jay peak', region: 'Vermont', skiable_acres: 385, vertical_ft: 2153, summit_elev_ft: 3968, base_elev_ft: 1815, avg_snowfall_in: 359, pass_networks: ['Indy'] },
  { match: 'stowe', region: 'Vermont', skiable_acres: 485, vertical_ft: 2360, summit_elev_ft: 3625, base_elev_ft: 1265, avg_snowfall_in: 314, pass_networks: ['Epic'] },
  { match: 'sugarbush', region: 'Vermont', skiable_acres: 581, vertical_ft: 2600, summit_elev_ft: 4083, base_elev_ft: 1483, avg_snowfall_in: 250, pass_networks: ['Ikon'] },
  { match: 'sugarloaf', region: 'Maine', skiable_acres: 1360, vertical_ft: 2820, summit_elev_ft: 4237, base_elev_ft: 1417, avg_snowfall_in: 200, pass_networks: ['Ikon'] },
  { match: 'sunday river', region: 'Maine', skiable_acres: 884, vertical_ft: 2340, summit_elev_ft: 3140, base_elev_ft: 800, avg_snowfall_in: 167, pass_networks: ['Ikon'] },
  { match: 'whiteface', region: 'New York', skiable_acres: 299, vertical_ft: 3430, summit_elev_ft: 4386, base_elev_ft: 1220, avg_snowfall_in: 190, pass_networks: ['Independent'] },
];

const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

let verifiedApplied = 0;
let snowNulled = 0;
let acresZeroed = 0;
let summariesStripped = 0;

for (const f of fc.features) {
  const p = f.properties;
  if (!p) continue;

  const nameLower = (p.name || '').toLowerCase();
  const regionLower = (p.region || '').toLowerCase();
  const isDownhill = p.category === 'downhill';

  // Match verified resort spec (downhill only so we don't match adjacent Nordic centers)
  let spec = null;
  if (isDownhill) {
    spec = VERIFIED_RESORT_SPECS.find((s) => {
      const regionMatch = regionLower.includes(s.region.toLowerCase());
      const nameMatch =
        nameLower.includes(s.match) ||
        (s.altMatch && nameLower.includes(s.altMatch));
      return regionMatch && nameMatch;
    });
  }

  if (spec) {
    p.skiable_acres = spec.skiable_acres;
    p.vertical_ft = spec.vertical_ft;
    p.summit_elev_ft = spec.summit_elev_ft;
    p.base_elev_ft = spec.base_elev_ft;
    p.avg_snowfall_in = spec.avg_snowfall_in;
    p.pass_networks = spec.pass_networks;
    p.primary_pass = spec.pass_networks[0];
    verifiedApplied++;
  } else {
    if (p.avg_snowfall_in != null) {
      p.avg_snowfall_in = null;
      snowNulled++;
    }
    if (p.skiable_acres && p.skiable_acres > 0) {
      p.skiable_acres = 0;
      acresZeroed++;
    }
  }

  if (p.summary && /offering scenic mountain slopes and winter recreation/i.test(p.summary)) {
    p.summary = '';
    summariesStripped++;
  }
}

fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
console.log(
  `Sanitized global_ski_areas.json: verified=${verifiedApplied}, snowNulled=${snowNulled}, acresZeroed=${acresZeroed}, summariesStripped=${summariesStripped}`
);
