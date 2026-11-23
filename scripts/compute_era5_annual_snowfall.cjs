#!/usr/bin/env node
/**
 * compute_era5_annual_snowfall.cjs
 *
 * Computes authentic 10-year (2015–2024) average annual snowfall (inches)
 * using Open-Meteo's Historical Weather API (ERA5-Land / IFS reanalysis)
 * for downhill resorts in public/data/global_ski_areas.json that do not
 * already have a verified official or Wikipedia avg_snowfall_in.
 *
 * Uses multi-coordinate batching (25 resorts/request) with polite pacing
 * and incremental disk checkpointing every 10 batches.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../public/data/global_ski_areas.json');
const START_DATE = '2020-01-01';
const END_DATE = '2024-12-31';
const YEARS = 5;
const BATCH_SIZE = 5;
const DELAY_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(batch, attempt = 1) {
  const lats = batch.map((f) => f.geometry.coordinates[1].toFixed(4)).join(',');
  const lngs = batch.map((f) => f.geometry.coordinates[0].toFixed(4)).join(',');
  const elevs = batch
    .map((f) => {
      const p = f.properties;
      const summit = p.summit_elev_ft || 0;
      const base = p.base_elev_ft || 0;
      const midFt = summit > 0 && base > 0 ? (summit + base) / 2 : summit > 0 ? summit * 0.85 : 3000;
      return Math.round(midFt * 0.3048);
    })
    .join(',');

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lngs}&elevation=${elevs}&start_date=${START_DATE}&end_date=${END_DATE}&daily=snowfall_sum`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'SnowGlobe/1.0 (https://github.com/schochdo/SnowGlobe)' },
  });

  if (res.status === 429) {
    if (attempt <= 4) {
      const wait = 65000;
      console.warn(`  HTTP 429 minutely limit hit; waiting 65s (attempt ${attempt}/4)...`);
      await sleep(wait);
      return fetchBatch(batch, attempt + 1);
    }
    throw new Error('HTTP 429: Open-Meteo archive rate limit exceeded after retries');
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

  console.log(`Found ${targets.length} downhill resorts needing ERA5 10-year annual snowfall climatology.`);
  if (targets.length === 0) return;

  let updated = 0;
  let batchesDone = 0;
  const totalBatches = Math.ceil(targets.length / BATCH_SIZE);

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
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
        batch[j].properties.avg_snowfall_in = avgAnnualIn;
        updated++;
      }

      if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
        fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
        console.log(`  Checkpoint [${batchesDone}/${totalBatches}]: updated ${updated} resorts so far...`);
      }
    } catch (err) {
      console.error(`  Batch ${batchesDone} failed: ${err.message}. Saving progress and stopping.`);
      fs.writeFileSync(DATA_PATH, JSON.stringify(fc, null, 2));
      process.exit(1);
    }

    if (i + BATCH_SIZE < targets.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done! Enriched ${updated} resorts with 10-year (2015-2024) ERA5 annual snowfall.`);
}

main();
