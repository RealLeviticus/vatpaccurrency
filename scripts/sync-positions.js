#!/usr/bin/env node
/**
 * Sync VATPAC positions from vatSys GitHub datasets
 * Fetches both Sectors.xml AND Positions.xml from australia-dataset and pacific-dataset,
 * extracts all VATSIM callsigns, and generates a shared positions.js module.
 *
 * Sources:
 *   - Sectors.xml: Each <Sector> has a Callsign attribute (primary source)
 *   - Positions.xml: Each <Position> has <ControllerInfo Callsign="..."> elements
 *
 * Non-VATPAC sectors (neighboring FIRs) identified by DisplayInSectorsWindow="False"
 * are excluded from Sectors.xml parsing.
 *
 * Usage: node scripts/sync-positions.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATASETS = ['australia-dataset', 'pacific-dataset'];
const BASE_URL = 'https://raw.githubusercontent.com/vatSys';
const FILES = ['Sectors.xml', 'Positions.xml'];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vatpac-sync/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract VATPAC callsigns from Sectors.xml content.
 * Each <Sector> element has a Callsign attribute with the VATSIM callsign.
 * Sectors with DisplayInSectorsWindow="False" are neighboring FIR sectors
 * (Indonesia, NZ, Fiji, PNG, etc.) and are excluded.
 */
function extractFromSectors(xml) {
  const callsigns = new Set();
  const sectorRegex = /<Sector\s+([^>]+?)(?:\/>|>)/g;
  let match;

  while ((match = sectorRegex.exec(xml)) !== null) {
    const attrs = match[1];
    if (/DisplayInSectorsWindow\s*=\s*"False"/i.test(attrs)) continue;
    const csMatch = attrs.match(/Callsign\s*=\s*"([^"]+)"/);
    if (csMatch) callsigns.add(csMatch[1]);
  }

  return callsigns;
}

/**
 * Extract callsigns from Positions.xml content.
 * Each <Position> contains <ControllerInfo Callsign="XX_YYY"> elements.
 */
function extractFromPositions(xml) {
  const callsigns = new Set();
  const ciRegex = /<ControllerInfo\s+([^>]+?)(?:\/>|>)/g;
  let match;

  while ((match = ciRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const csMatch = attrs.match(/Callsign\s*=\s*"([^"]+)"/);
    if (csMatch) callsigns.add(csMatch[1]);
  }

  return callsigns;
}

async function main() {
  console.log('Syncing VATPAC positions from vatSys GitHub datasets...\n');

  const allCallsigns = new Set();

  for (const dataset of DATASETS) {
    console.log(`Fetching ${dataset}...`);
    let datasetCount = 0;

    for (const file of FILES) {
      try {
        const url = `${BASE_URL}/${dataset}/refs/heads/master/${file}`;
        const xml = await fetch(url);
        const callsigns = file === 'Sectors.xml'
          ? extractFromSectors(xml)
          : extractFromPositions(xml);
        console.log(`  ${file}: ${callsigns.size} callsigns`);
        datasetCount += callsigns.size;
        callsigns.forEach(cs => allCallsigns.add(cs));
      } catch (err) {
        console.error(`  ERROR fetching ${file}: ${err.message}`);
      }
    }
    console.log(`  Total from ${dataset}: ${datasetCount} (before dedup)`);
  }

  // Sort callsigns into categories
  const sorted = [...allCallsigns].sort();
  const categories = {
    DEL: [], GND: [], TWR: [], APP: [], DEP: [], CTR: [], FSS: [], FMP: [], OTHER: []
  };

  for (const cs of sorted) {
    const suffix = cs.split('_').pop();
    if (categories[suffix]) {
      categories[suffix].push(cs);
    } else {
      categories.OTHER.push(cs);
    }
  }

  console.log(`\nTotal unique callsigns: ${allCallsigns.size}`);
  for (const [cat, items] of Object.entries(categories)) {
    if (items.length > 0) {
      console.log(`  ${cat}: ${items.length}`);
    }
  }

  // Generate positions.js
  const timestamp = new Date().toISOString();
  const output = `/**
 * VATPAC Position Callsigns
 * Auto-generated from vatSys datasets - DO NOT EDIT MANUALLY
 *
 * Sources:
 *   - https://github.com/vatSys/australia-dataset (Sectors.xml + Positions.xml)
 *   - https://github.com/vatSys/pacific-dataset (Sectors.xml + Positions.xml)
 *
 * Last synced: ${timestamp}
 * Total callsigns: ${allCallsigns.size}
 *
 * To update, run: node scripts/sync-positions.js
 */

// Aerodrome positions (DEL/GND/TWR)
const AERODROME = [
${formatArray([...categories.DEL, ...categories.GND, ...categories.TWR])}
];

// Approach/Departure positions (APP/DEP)
const APPROACH = [
${formatArray([...categories.APP, ...categories.DEP])}
];

// Enroute positions (CTR/FSS)
const ENROUTE = [
${formatArray([...categories.CTR, ...categories.FSS])}
];

// Flow positions (FMP)
const FLOW = [
${formatArray(categories.FMP)}
];

${categories.OTHER.length > 0 ? `// Other positions\nconst OTHER = [\n${formatArray(categories.OTHER)}\n];\n` : ''}
/**
 * Complete set of all VATPAC callsigns
 * Used by workers to identify VATPAC controller sessions on VATSIM
 */
export const VATPAC_CALLSIGNS = new Set([
  ...AERODROME,
  ...APPROACH,
  ...ENROUTE,
  ...FLOW${categories.OTHER.length > 0 ? ',\n  ...OTHER' : ''}
]);

/**
 * Array version for StatSim API queries
 */
export const PAC_CALLSIGNS = [...VATPAC_CALLSIGNS];
`;

  const outPath = path.join(__dirname, '..', 'positions.js');
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`\nWrote ${outPath}`);
}

function formatArray(items) {
  if (items.length === 0) return '';
  // Format as rows of ~8 items each
  const rows = [];
  for (let i = 0; i < items.length; i += 8) {
    const chunk = items.slice(i, i + 8);
    rows.push('  ' + chunk.map(c => `'${c}'`).join(', '));
  }
  return rows.join(',\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
