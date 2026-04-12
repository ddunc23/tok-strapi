import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1));

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadEnvFiles() {
  const root = process.cwd();
  loadEnvFile(path.join(root, '.env'));
  loadEnvFile(path.join(root, '.env.local'));
}

loadEnvFiles();

const DEFAULT_BASE_URL = process.env.STRAPI_URL || process.env.API_ROOT || 'http://localhost:1337';
const API_TOKEN = process.env.STRAPI_API_TOKEN || process.env.API_KEY || '';

const argv = process.argv.slice(2);

function hasFlag(...flags) {
  return flags.some((flag) => argv.includes(flag));
}

function getArgValue(...flags) {
  for (const flag of flags) {
    const exactIndex = argv.indexOf(flag);
    if (exactIndex >= 0) {
      const next = argv[exactIndex + 1];
      if (next && !next.startsWith('--')) return next;
    }

    const prefix = `${flag}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
  }

  return undefined;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const options = {
  deleteExisting: hasFlag('--delete-existing', '--delete'),
  deleteOnly: hasFlag('--delete-only'),
  dryRun: hasFlag('--dry-run'),
  relationsOnly: hasFlag('--relations-only'),
  csvDir: process.env.CSV_DIR || path.join(process.cwd(), 'data', 'csv'),
  relationBatchSize: parsePositiveInt(
    getArgValue('--relation-batch-size', '--batch-size') ?? process.env.RELATION_BATCH_SIZE,
    500
  ),
  relationLimit: parsePositiveInt(
    getArgValue('--limit-relations') ?? process.env.RELATION_LIMIT,
    null
  ),
};

const COLLECTIONS = [
  {
    name: 'makers',
    endpoint: 'makers',
    csvFiles: ['maker.csv'],
    integerFields: ['maker_id'],
    keyFields: ['maker_id'],
  },
  {
    name: 'addresses',
    endpoint: 'addresses',
    csvFiles: ['address.csv'],
    integerFields: ['address_id', 'maker_id', 'town_location_id'],
    keyFields: ['address_id'],
  },
  {
    name: 'townLocations',
    endpoint: 'town-locations',
    csvFiles: ['town-location.csv'],
    integerFields: ['town_location_id'],
    keyFields: ['town_location_id'],
  },
  {
    name: 'guilds',
    endpoint: 'guilds',
    csvFiles: ['guild.csv'],
    integerFields: ['guild_id'],
    keyFields: ['guild_id'],
  },
  {
    name: 'memberships',
    endpoint: 'memberships',
    csvFiles: ['membership.csv'],
    integerFields: ['membership_id', 'guild_id', 'maker_id'],
    excludeFields: [
      'entry',
      'entry_date_1',
      'entry_date_2',
      'uncertain',
      'misc_codes',
      'entry_date_1_certainty',
      'entry_date_2_certainty',
    ],
    keyFields: ['membership_id'],
  },
  {
    name: 'relations',
    endpoint: 'relations',
    csvFiles: ['relation.csv'],
    integerFields: ['maker_id', 'relation_code', 'relation_id', 'relation_type_id', 'target_maker_id'],
    excludeFields: ['relation_type_meta_id'],
    keyFields: ['relation_id'],
  },
  {
    name: 'instrumentsKnown',
    endpoint: 'instruments-known',
    csvFiles: ['instrument-known.csv', 'instrument_known.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
  },
  {
    name: 'instrumentsAdvertised',
    endpoint: 'instruments-advertised',
    csvFiles: ['instrument-advertised.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
  },
];

const RELATION_LINKS = [
  {
    sourceEndpoint: 'addresses',
    targetEndpoint: 'makers',
    sourceIdField: 'maker_id',
    targetIdField: 'maker_id',
    connectionField: 'addresses',
  },
  {
    sourceEndpoint: 'town-locations',
    targetEndpoint: 'addresses',
    sourceIdField: 'town_location_id',
    targetIdField: 'town_location_id',
    connectionField: 'town_location',
  },
  {
    sourceEndpoint: 'makers',
    targetEndpoint: 'memberships',
    sourceIdField: 'maker_id',
    targetIdField: 'maker_id',
    connectionField: 'maker',
  },
  {
    sourceEndpoint: 'guilds',
    targetEndpoint: 'memberships',
    sourceIdField: 'guild_id',
    targetIdField: 'guild_id',
    connectionField: 'guild',
  },
  {
    sourceEndpoint: 'relations',
    targetEndpoint: 'makers',
    sourceIdField: 'maker_id',
    targetIdField: 'maker_id',
    connectionField: 'relations',
  },
  {
    sourceEndpoint: 'instruments-known',
    targetEndpoint: 'makers',
    sourceIdField: 'maker_id',
    targetIdField: 'maker_id',
    connectionField: 'instruments_known',
  },
  {
    sourceEndpoint: 'instruments-advertised',
    targetEndpoint: 'makers',
    sourceIdField: 'maker_id',
    targetIdField: 'maker_id',
    connectionField: 'instruments_advertised',
  },
];

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const BASE_URL = normalizeBaseUrl(DEFAULT_BASE_URL);

function getHeaders() {
  if (!API_TOKEN) {
    throw new Error('Missing API token. Set STRAPI_API_TOKEN (or API_KEY) in the environment.');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_TOKEN}`,
  };
}

function buildUrl(endpoint, query = '') {
  const suffix = query ? `?${query}` : '';
  return `${BASE_URL}/api/${endpoint}${suffix}`;
}

async function strapiFetch(url, init = {}) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || response.statusText;
    throw new Error(`${response.status} ${detail}`);
  }

  return payload;
}

function rowValueToNullable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function rowToRecord(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rowValueToNullable(value)]));
}

function castIntegerFields(record, integerFields = []) {
  const next = { ...record };

  for (const field of integerFields) {
    if (!(field in next)) continue;
    const value = next[field];
    if (value === null) {
      next[field] = null;
      continue;
    }

    const number = Number.parseInt(String(value), 10);
    next[field] = Number.isNaN(number) ? null : number;
  }

  return next;
}

function removeExcludedFields(record, excludeFields = []) {
  const next = { ...record };
  for (const field of excludeFields) {
    delete next[field];
  }
  return next;
}

function normalizeRecord(row, config) {
  const withNulls = rowToRecord(row);
  const withIntegers = castIntegerFields(withNulls, config.integerFields);
  return removeExcludedFields(withIntegers, config.excludeFields);
}

function findCsvPath(csvDir, candidates) {
  for (const fileName of candidates) {
    const absolutePath = path.join(csvDir, fileName);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }

  return null;
}

function readCsvRecords(config, csvDir) {
  const csvPath = findCsvPath(csvDir, config.csvFiles);
  if (!csvPath) {
    throw new Error(`CSV not found for ${config.name}. Expected one of: ${config.csvFiles.join(', ')}`);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const parsed = parse(content, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  return parsed.map((row) => normalizeRecord(row, config));
}

function getFieldValue(record, fieldName) {
  if (record && fieldName in record) return record[fieldName];
  if (record?.attributes && fieldName in record.attributes) return record.attributes[fieldName];
  return null;
}

function getDocumentId(record) {
  return record?.documentId || record?.id || null;
}

function makeRecordKey(record, fields) {
  return fields.map((field) => {
    const value = getFieldValue(record, field);
    return value === null || value === undefined ? '' : String(value);
  }).join('::');
}

function collectDuplicateKeys(records, fields) {
  const counts = new Map();

  for (const record of records) {
    const key = makeRecordKey(record, fields);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].filter(([, count]) => count > 1);
}

async function fetchAll(endpoint, params = {}) {
  const requestedPageSize = 200;
  let page = 1;
  const allRows = [];
  let pagesWithoutData = 0;

  while (true) {
    const query = new URLSearchParams();
    query.set('pagination[page]', String(page));
    query.set('pagination[pageSize]', String(requestedPageSize));

    for (const [key, value] of Object.entries(params)) {
      query.set(key, String(value));
    }

    const payload = await strapiFetch(buildUrl(endpoint, query.toString()));
    const rows = payload?.data || [];

    if (!rows.length) {
      pagesWithoutData += 1;
      if (pagesWithoutData >= 1) {
        break;
      }
    } else {
      pagesWithoutData = 0;
      allRows.push(...rows);
    }

    const responsePageSize = payload?.meta?.pagination?.pageSize;
    if (typeof responsePageSize === 'number' && rows.length < responsePageSize) {
      break;
    }

    if (rows.length < requestedPageSize && (!responsePageSize || responsePageSize === requestedPageSize)) {
      break;
    }

    page += 1;
  }

  return allRows;
}

async function createEntry(endpoint, data) {
  if (options.dryRun) return;

  return strapiFetch(buildUrl(endpoint), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ data }),
  });
}

async function deleteEntry(endpoint, documentId) {
  if (options.dryRun) return;

  await strapiFetch(`${buildUrl(endpoint)}/${documentId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
}

async function updateEntry(endpoint, documentId, data) {
  if (options.dryRun) return;

  await strapiFetch(`${buildUrl(endpoint)}/${documentId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ data }),
  });
}

async function deleteCsvRepresentedRecords(config) {
  const csvRecords = readCsvRecords(config, options.csvDir);
  const csvKeySet = new Set(csvRecords.map((row) => makeRecordKey(row, config.keyFields)));
  const strapiRows = await fetchAll(config.endpoint);

  let deleted = 0;

  for (const row of strapiRows) {
    const rowKey = makeRecordKey(row, config.keyFields);
    if (!csvKeySet.has(rowKey)) continue;

    const documentId = getDocumentId(row);
    if (!documentId) continue;

    await deleteEntry(config.endpoint, documentId);
    deleted += 1;
  }

  console.log(`[delete] ${config.endpoint}: removed ${deleted} CSV-represented records`);
}

async function uploadCollection(config) {
  const rows = readCsvRecords(config, options.csvDir);
  const existingRows = await fetchAll(config.endpoint);

  const duplicateCsvKeys = collectDuplicateKeys(rows, config.keyFields);
  if (duplicateCsvKeys.length) {
    console.warn(
      `[preflight] ${config.endpoint}: found ${duplicateCsvKeys.length} duplicate key(s) in CSV for key fields [${config.keyFields.join(', ')}]. Sample: ${duplicateCsvKeys.slice(0, 5).map(([key, count]) => `${key} (${count})`).join(', ')}`
    );
  }

  const duplicateStrapiKeys = collectDuplicateKeys(existingRows, config.keyFields);
  if (duplicateStrapiKeys.length) {
    console.warn(
      `[preflight] ${config.endpoint}: found ${duplicateStrapiKeys.length} duplicate key(s) already in Strapi for key fields [${config.keyFields.join(', ')}]. Sample: ${duplicateStrapiKeys.slice(0, 5).map(([key, count]) => `${key} (${count})`).join(', ')}`
    );
  }

  const existingKeyToDocumentId = new Map();
  const processedInputKeys = new Set();

  for (const existingRow of existingRows) {
    const rowKey = makeRecordKey(existingRow, config.keyFields);
    const documentId = getDocumentId(existingRow);
    if (!rowKey || !documentId) continue;

    if (!existingKeyToDocumentId.has(rowKey)) {
      existingKeyToDocumentId.set(rowKey, documentId);
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let skippedDuplicateInput = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const rowKey = makeRecordKey(row, config.keyFields);
      if (!rowKey) {
        skipped += 1;
        continue;
      }

      if (processedInputKeys.has(rowKey)) {
        skippedDuplicateInput += 1;
        continue;
      }
      processedInputKeys.add(rowKey);

      const existingDocumentId = existingKeyToDocumentId.get(rowKey);

      if (existingDocumentId) {
        await updateEntry(config.endpoint, existingDocumentId, row);
        updated += 1;
      } else {
        const createdPayload = await createEntry(config.endpoint, row);
        const createdDocumentId = getDocumentId(createdPayload?.data);
        if (createdDocumentId) {
          existingKeyToDocumentId.set(rowKey, createdDocumentId);
        }
        created += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`[upload] ${config.endpoint} failed: ${error.message}`);
    }
  }

  console.log(
    `[upload] ${config.endpoint}: ${created} created, ${updated} updated, ${skipped} skipped, ${skippedDuplicateInput} skippedDuplicateInput, ${failed} failed`
  );
}

function makeMapByField(records, fieldName) {
  const map = new Map();

  for (const record of records) {
    const fieldValue = getFieldValue(record, fieldName);
    const documentId = getDocumentId(record);
    if (fieldValue === null || fieldValue === undefined || !documentId) continue;

    const key = String(fieldValue);
    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(documentId);
  }

  return map;
}

async function connectRelation(linkConfig) {
  const sourceRows = await fetchAll(linkConfig.sourceEndpoint);
  const targetRows = await fetchAll(linkConfig.targetEndpoint);
  const targetMap = makeMapByField(targetRows, linkConfig.targetIdField);
  const relationSourceRows = options.relationLimit
    ? sourceRows.slice(0, options.relationLimit)
    : sourceRows;

  let connected = 0;
  let skipped = 0;
  let failed = 0;

  for (let start = 0; start < relationSourceRows.length; start += options.relationBatchSize) {
    const batch = relationSourceRows.slice(start, start + options.relationBatchSize);

    for (const sourceRow of batch) {
      const sourceDocumentId = getDocumentId(sourceRow);
      const sourceForeignKey = getFieldValue(sourceRow, linkConfig.sourceIdField);

      if (!sourceDocumentId || sourceForeignKey === null || sourceForeignKey === undefined) {
        skipped += 1;
        continue;
      }

      const targetDocumentIds = targetMap.get(String(sourceForeignKey));
      if (!targetDocumentIds || !targetDocumentIds.length) {
        skipped += 1;
        continue;
      }

      for (const targetDocumentId of targetDocumentIds) {
        try {
          await updateEntry(linkConfig.targetEndpoint, targetDocumentId, {
            [linkConfig.connectionField]: {
              connect: [sourceDocumentId],
            },
          });
          connected += 1;
        } catch (error) {
          failed += 1;
          console.error(
            `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint} failed: ${error.message}`
          );
        }
      }
    }

    console.log(
      `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: processed ${Math.min(start + batch.length, relationSourceRows.length)}/${relationSourceRows.length} source rows`
    );
  }

  console.log(
    `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: ${connected} connected, ${skipped} skipped, ${failed} failed`
  );
}

async function connectTargetMakers() {
  // target_maker_id is now a stored field on relation records, so we can drive
  // this pass entirely from the API without re-reading the CSV.
  const allRelationRows = await fetchAll('relations');
  const relationSourceRows = options.relationLimit
    ? allRelationRows.slice(0, options.relationLimit)
    : allRelationRows;

  const makerRows = await fetchAll('makers');
  const makerMap = makeMapByField(makerRows, 'maker_id');

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  const processedMakerDocumentIds = new Set();

  for (let start = 0; start < relationSourceRows.length; start += options.relationBatchSize) {
    const batch = relationSourceRows.slice(start, start + options.relationBatchSize);

    for (const relationRow of batch) {
      const targetMakerId = getFieldValue(relationRow, 'target_maker_id');
      const relationDocumentId = getDocumentId(relationRow);

      if (targetMakerId === null || targetMakerId === undefined || !relationDocumentId) {
        skipped += 1;
        continue;
      }

      const makerDocumentIds = makerMap.get(String(targetMakerId));
      if (!makerDocumentIds?.length) {
        skipped += 1;
        continue;
      }

      const makerDocumentId = makerDocumentIds[0];

      if (processedMakerDocumentIds.has(makerDocumentId)) {
        skipped += 1;
        continue;
      }

      try {
        await updateEntry('makers', makerDocumentId, {
          relation_target: {
            connect: [relationDocumentId],
          },
        });
        processedMakerDocumentIds.add(makerDocumentId);
        connected += 1;
      } catch (error) {
        failed += 1;
        console.error(`[connect] relations.target_maker_id -> makers.relation_target failed: ${error.message}`);
      }
    }

    console.log(
      `[connect] relations -> makers (target_maker): processed ${Math.min(start + batch.length, relationSourceRows.length)}/${relationSourceRows.length} source rows`
    );
  }

  console.log(
    `[connect] relations -> makers (target_maker): ${connected} connected, ${skipped} skipped, ${failed} failed`
  );
}


async function run() {
  const mode = options.relationsOnly
    ? 'relations-only'
    : options.deleteOnly
      ? 'delete-only'
      : options.deleteExisting
        ? 'delete+import'
        : 'import';

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`CSV dir: ${options.csvDir}`);
  console.log(`Mode: ${mode}`);
  console.log(`Relation batch size: ${options.relationBatchSize}`);
  if (options.relationLimit) {
    console.log(`Relation source limit: ${options.relationLimit}`);
  }
  if (options.dryRun) {
    console.log('Dry run enabled: no write operations will be sent.');
  }

  if (!options.relationsOnly && (options.deleteExisting || options.deleteOnly)) {
    for (const config of COLLECTIONS) {
      await deleteCsvRepresentedRecords(config);
    }
  }

  if (!options.relationsOnly && !options.deleteOnly) {
    for (const config of COLLECTIONS) {
      await uploadCollection(config);
    }
  }

  if (!options.deleteOnly) {
    for (const linkConfig of RELATION_LINKS) {
      await connectRelation(linkConfig);
    }

    await connectTargetMakers();
  }

  console.log('CSV sync complete.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
