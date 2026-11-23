#!/usr/bin/env node
/**
 * compute_era5_annual_snowfall.cjs
 *
 * Computes authentic 3-year (2022–2024) average annual snowfall (inches)
 * using Open-Meteo's Historical Weather API (ERA5-Land / IFS reanalysis)
 * for downhill resorts in public/data/global_ski_areas.json without
 * verified official/Wikipedia avg_snowfall_in.
 *
 * Optimizations to stay under Open-Meteo's free-tier limits (600/min, 5k/hr, 10k/day):
 * 1. Clusters resorts into 0.15-deg (~15km) ERA5 grid cells (1 query per cell).
 * 2. Prioritizes major resorts first (sorted by vertical_ft & lift_count).
 * 3. Uses 3-year window, 2 cells/batch, and 4s delay (~225 weighted calls/min).
 * 4. Checkpoints every 10 batches and exits cleanly if hourly/daily quota is reached.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const START_DATE = '2022-01-01';
const END_DATE = '2024-12-31';
const YEARS = 3;
const BATCH_SIZE = 2;
const DELAY_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(cells, attempt = 1) {
  const lats = cells.map((c) => c.lat.toFixed(4)).join(',');
  const lngs = cells.map((c) => c.lng.toFixed(4)).join(',');
  const elevs = cells.map((c) => c.elevM).join(',');

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lngs}&elevation=${elevs}&start_date=${START_DATE}&end_date=${END_DATE}&daily=snowfall_sum`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'SnowGlobe/1.0 (https://github.com/schochdo/SnowGlobe)' },
  });

  if (res.status === 429) {
    const body = await res.text();
    const isHourlyOrDaily = /hourly|daily|tomorrow/i.test(body);
    if (isHourlyOrDaily) {
      throw new Error(`QUOTA_REACHED: ${body}`);
    }
    if (attempt <= 3) {
      console.warn(`  HTTP 429 minutely limit hit; waiting 65s (attempt ${attempt}/3)...`);
      await sleep(65000);
      return fetchBatch(cells, attempt + 1);
    }
    throw new Error(`HTTP 429 after retries: ${body}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

async function main() {
  const fc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  const targets = fc.features.filter(
    (f) =>
      f.properties &&
      f.properties.category === 'downhill' &&
      f.properties.avg_snowfall_in == null &&
      Array.isArray(f.geometry?.coordinates)
  );

  // Cluster onto 0.15-deg (~15km) ERA5 grid cells
  const cellMap = new Map();
  for (const f of targets) {
    const [lng, lat] = f.geometry.coordinates;
    const key = `${Math.round(lat / 0.15)},${Math.round(lng / 0.15)}`;
    let cell = cellMap.get(key);
    if (!cell) {
      const p = f.properties;
      const summit = p.summit_elev_ft || 0;
      const base = p.base_elev_ft || 0;
      const midFt = summit > 0 && base > 0 ? (summit + base) / 2 : summit > 0 ? summit * 0.85 : 3000;
      cell = {
        lat,
        lng,
        elevM: Math.round(midFt * 0.3048),
        maxPriority: (p.vertical_ft || 0) + (p.lift_count || 0) * 100,
        features: [],
      };
      cellMap.set(key, cell);
    }
    const prio = (f.properties.vertical_ft || 0) + (f.properties.lift_count || 0) * 100;
    if (prio > cell.maxPriority) {
      cell.maxPriority = prio;
      cell.lat = lat;
      cell.lng = lng;
    }
    cell.features.push(f);
  }

  // Sort cells so major ski resorts are enriched first
  const cells = Array.from(cellMap.values()).sort((a, b) => b.maxPriority - a.maxPriority);
  console.log(`Found ${targets.length} resorts clustered into ${cells.length} ERA5 grid cells (major resorts first).`);
  if (cells.length === 0) return;

  let updatedResorts = 0;
  let batchesDone = 0;
  const totalBatches = Math.ceil(cells.length / BATCH_SIZE);

  for (let i = 0; i < cells.length; i += BATCH_SIZE) {
    const batch = cells.slice(i, i + BATCH_SIZE);
    batchesDone++;

    try {
      const payloads = await fetchBatch(batch);
      for (let j = 0; j < batch.length && j < payloads.length; j++) {
        const dailySnow = payloads[j]?.daily?.snowfall_sum;
        if (!Array.isArray(dailySnow) || dailySnow.length === 0) continue;

        let totalCm = 0;
        for (const v of dailySnow) {
          if (typeof v === 'number' && isFinite(v) && v > 0) totalCm += v;
        }
        const avgAnnualIn = Math.round(totalCm / YEARS / 2.54);
        for (const feat of batch[j].features) {
          feat.properties.avg_snowfall_in = avgAnnualIn;
          updatedResorts++;
        }
      }

      if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
        fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
        console.log(`  Checkpoint [${batchesDone}/${totalBatches}]: updated ${updatedResorts} resorts so far...`);
      }
    } catch (err) {
      fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
      if (err.message.startsWith('QUOTA_REACHED')) {
        console.log(`\nSaved progress (${updatedResorts} resorts updated). Open-Meteo hourly/daily quota reached — re-run later to resume.`);
        process.exit(0);
      }
      console.error(`  Batch ${batchesDone} failed: ${err.message}. Progress saved.`);
      process.exit(1);
    }

    if (i + BATCH_SIZE < cells.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done! Enriched ${updatedResorts} resorts with 3-year (2022-2024) ERA5 annual snowfall.`);
}

main();
