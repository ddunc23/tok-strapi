import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const CSV_DIR = process.env.CSV_DIR || path.join(process.cwd(), 'data', 'csv');

const CSV_CONFIGS = [
  {
    name: 'makers-extended',
    csvFiles: ['makers-extended-with-events.csv', 'maker-extended.csv', 'maker-extended-extract.csv'],
    keyFields: ['Maker_ID'],
    requiredFields: ['Maker_ID'],
    integerFields: ['Maker_ID'],
    dateFields: ['Birth_Date', 'Establishment_Date', 'Working_Start_Date', 'Working_End_Date', 'Flourishing_Start_Date', 'Flourishing_End_Date', 'Retirement_Date', 'Death_Date', 'Date_1', 'Date_2'],
  },
  {
    name: 'addresses',
    csvFiles: ['address.csv'],
    keyFields: ['address_id'],
    requiredFields: ['address_id'],
    integerFields: ['address_id', 'maker_id', 'town_location_id'],
    foreignKeys: { maker_id: 'makers-extended::Maker_ID', town_location_id: 'town-locations::town_location_id' },
  },
  {
    name: 'town-locations',
    csvFiles: ['town-location.csv'],
    keyFields: ['town_location_id'],
    requiredFields: ['town_location_id'],
    integerFields: ['town_location_id'],
  },
  {
    name: 'guilds',
    csvFiles: ['guild.csv'],
    keyFields: ['guild_id'],
    requiredFields: ['guild_id'],
    integerFields: ['guild_id'],
  },
  {
    name: 'memberships',
    csvFiles: ['membership.csv'],
    keyFields: ['membership_id'],
    requiredFields: ['membership_id'],
    integerFields: ['membership_id', 'guild_id', 'maker_id'],
    foreignKeys: { maker_id: 'makers-extended::Maker_ID', guild_id: 'guilds::guild_id' },
  },
  {
    name: 'relations',
    csvFiles: ['relation.csv'],
    keyFields: ['relation_id'],
    requiredFields: ['relation_id'],
    integerFields: ['maker_id', 'relation_code', 'relation_id', 'relation_type_id', 'target_maker_id'],
    foreignKeys: { maker_id: 'makers-extended::Maker_ID', target_maker_id: 'makers-extended::Maker_ID' },
  },
  {
    name: 'instruments-known',
    csvFiles: ['instrument-known.csv', 'instrument_known.csv'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
    requiredFields: ['maker_id'],
    integerFields: ['maker_id', 'inst_code'],
    foreignKeys: { maker_id: 'makers-extended::Maker_ID' },
  },
  {
    name: 'instruments-advertised',
    csvFiles: ['instrument-advertised.csv'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
    requiredFields: ['maker_id'],
    integerFields: ['maker_id', 'inst_code'],
    foreignKeys: { maker_id: 'makers-extended::Maker_ID' },
  },
];

function findCsvPath(candidates) {
  for (const fileName of candidates) {
    const absolutePath = path.join(CSV_DIR, fileName);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }
  return null;
}

function loadCsv(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf8');
  return parse(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
}

function validateRow(row, config, rowNumber) {
  const errors = [];

  // Check required fields
  for (const field of config.requiredFields || []) {
    const value = row[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // Check integer fields
  for (const field of config.integerFields || []) {
    const value = row[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      continue; // null is ok
    }
    const num = Number.parseInt(String(value), 10);
    if (Number.isNaN(num)) {
      errors.push(`invalid integer for field ${field}: ${value}`);
    }
  }

  // Check date fields
  for (const field of config.dateFields || []) {
    const value = row[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      continue; // null is ok
    }
    const str = String(value).trim();
    if (!(/^\d{4}$/.test(str) || /^\d{4}-\d{2}-\d{2}$/.test(str))) {
      errors.push(`invalid date format for field ${field}: ${value} (expected YYYY or YYYY-MM-DD)`);
    }
  }

  return errors;
}

function checkDuplicateKeys(rows, keyFields) {
  const seen = new Map();
  const duplicates = [];

  for (const row of rows) {
    const key = keyFields.map((f) => row[f] ?? '').join('::');
    if (key && seen.has(key)) {
      duplicates.push(key);
    }
    if (key) {
      seen.set(key, true);
    }
  }

  return [...new Set(duplicates)];
}

function buildLookupMap(rows, keyField) {
  const map = new Set();
  for (const row of rows) {
    const value = row[keyField];
    if (value !== undefined && value !== null && value !== '') {
      map.add(String(value));
    }
  }
  return map;
}

function checkForeignKeys(rows, config, lookupMaps) {
  const orphans = new Map();

  for (const row of rows) {
    for (const [fkField, fkRef] of Object.entries(config.foreignKeys || {})) {
      const fkValue = row[fkField];
      if (fkValue === undefined || fkValue === null || (typeof fkValue === 'string' && fkValue.trim() === '')) {
        continue; // null is ok
      }

      const [targetCollection, targetField] = fkRef.split('::');
      const lookupKey = `${targetCollection}::${targetField}`;
      const targetMap = lookupMaps[lookupKey];

      if (!targetMap) {
        console.warn(`warning: target lookup map not available for ${lookupKey}`);
        continue;
      }

      if (!targetMap.has(String(fkValue))) {
        if (!orphans.has(fkField)) {
          orphans.set(fkField, new Map());
        }
        const counts = orphans.get(fkField);
        counts.set(String(fkValue), (counts.get(String(fkValue)) || 0) + 1);
      }
    }
  }

  return orphans;
}

async function checkIntegrity() {
  console.log(`[integrity] checking CSV data in: ${CSV_DIR}\n`);

  const allData = {};
  const loadOrder = ['makers-extended', 'town-locations', 'guilds', 'addresses', 'memberships', 'relations', 'instruments-known', 'instruments-advertised'];

  // Load and validate each collection
  for (const collectionName of loadOrder) {
    const config = CSV_CONFIGS.find((c) => c.name === collectionName);
    if (!config) continue;

    const csvPath = findCsvPath(config.csvFiles);
    if (!csvPath) {
      console.warn(`[warning] ${collectionName}: no CSV file found (looked for: ${config.csvFiles.join(', ')})`);
      continue;
    }

    console.log(`[check] ${collectionName}: reading ${path.basename(csvPath)}`);
    const rows = loadCsv(csvPath);
    allData[collectionName] = { rows, config };

    // Validate rows
    const invalidRows = [];
    for (let i = 0; i < rows.length; i++) {
      const errors = validateRow(rows[i], config, i + 2);
      if (errors.length) {
        invalidRows.push({ rowNumber: i + 2, errors });
      }
    }

    if (invalidRows.length) {
      console.log(
        `[invalid] ${collectionName}: ${invalidRows.length} rows with validation errors`
      );
      for (const { rowNumber, errors } of invalidRows.slice(0, 10)) {
        console.log(`  row ${rowNumber}: ${errors.join('; ')}`);
      }
      if (invalidRows.length > 10) {
        console.log(`  ... and ${invalidRows.length - 10} more`);
      }
    }

    // Check duplicate keys
    const duplicateKeys = checkDuplicateKeys(rows, config.keyFields);
    if (duplicateKeys.length) {
      console.log(`[duplicates] ${collectionName}: ${duplicateKeys.length} duplicate keys`);
      for (const key of duplicateKeys.slice(0, 20)) {
        console.log(`  ${key}`);
      }
      if (duplicateKeys.length > 20) {
        console.log(`  ... and ${duplicateKeys.length - 20} more`);
      }
    }

    console.log(`[summary] ${collectionName}: ${rows.length} rows loaded, ${invalidRows.length} invalid, ${duplicateKeys.length} duplicate keys\n`);
  }

  // Check foreign key integrity
  console.log(`[check] validating foreign key references...\n`);

  const lookupMaps = {};
  for (const collectionName of loadOrder) {
    const data = allData[collectionName];
    if (!data) continue;

    const { rows, config } = data;
    for (const keyField of config.keyFields) {
      const lookupKey = `${collectionName}::${keyField}`;
      lookupMaps[lookupKey] = buildLookupMap(rows, keyField);
    }
  }

  for (const collectionName of loadOrder) {
    const data = allData[collectionName];
    if (!data || !data.config.foreignKeys) continue;

    const { rows, config } = data;
    const orphans = checkForeignKeys(rows, config, lookupMaps);

    if (orphans.size) {
      console.log(`[orphans] ${collectionName}: found missing foreign key references`);
      for (const [fkField, orphanCounts] of orphans) {
        const sorted = [...orphanCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50);
        const uniqueCount = orphanCounts.size;
        const ids = sorted.map(([id]) => id).join(', ');
        console.log(`  ${fkField}: ${uniqueCount} unique missing, top 50: [${ids}]`);
      }
    }
  }

  console.log(`\n[integrity] check complete.`);
}

checkIntegrity().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
