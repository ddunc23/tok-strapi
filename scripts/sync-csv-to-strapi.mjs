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
  skipRelations: hasFlag('--skip-relations'),
  strictRelations: hasFlag('--strict-relations'),
  verboseSkips: hasFlag('--verbose-skips'),
  reportMissingTargets: hasFlag('--report-missing-targets'),
  clearRelationsOnly: hasFlag('--clear-relations-only'),
  csvDir: process.env.CSV_DIR || path.join(process.cwd(), 'data', 'csv'),
  collections: (() => {
    const value = getArgValue('--collections');
    if (!value) return null;
    const items = String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? new Set(items) : null;
  })(),
  relationBatchSize: parsePositiveInt(
    getArgValue('--relation-batch-size', '--batch-size') ?? process.env.RELATION_BATCH_SIZE,
    500
  ),
  relationLimit: parsePositiveInt(
    getArgValue('--limit-relations') ?? process.env.RELATION_LIMIT,
    null
  ),
};

const INSTRUMENT_TERM_SOURCE_HEADERS = [
  'ID',
  'Preferred_Label',
  'Alternative_Label 1',
  'Alternative_Label 2',
  'Alternative_Label 3',
  'Alternative_Label 4',
  'Alternative_Label 5',
  'Alternative_Label 6',
  'Broader 1',
  'Broader1_ID',
  'Broader 2',
  'Broader2_ID',
  'Broader 3',
  'Broader3_ID',
  'Broader 4',
  'Broader4_ID',
  'Narrower',
  'Related_1',
  'Related1_ID',
  'Related_2',
  'Related2_ID',
  'Related_3',
  'Related3_ID',
  'Related_4',
  'Related4_ID',
  'Related_5',
  'Related5_ID',
  'Related_6',
  'Related6_ID',
  'Related_7',
  'Related7_ID',
  'Related_8',
  'Related8_ID',
  'Wikidata_URI',
  'AAT_URI',
  'Additional_Information',
];

const INSTRUMENT_TERM_BROADER_ID_FIELDS = ['broader_1_id', 'broader_2_id', 'broader_3_id', 'broader_4_id'];
const INSTRUMENT_TERM_RELATED_ID_FIELDS = ['related_1_id', 'related_2_id', 'related_3_id', 'related_4_id', 'related_5_id', 'related_6_id', 'related_7_id', 'related_8_id'];

const COLLECTIONS = [
  {
    name: 'makersExtended',
    endpoint: 'makers-extended',
    csvFiles: ['makers-extended-with-events.csv', 'maker-extended.csv', 'maker-extended-extract.csv'],
    integerFields: ['Maker_ID'],
    dateFields: [
      'Birth_Date',
      'Establishment_Date',
      'Working_Start_Date',
      'Working_End_Date',
      'Flourishing_Start_Date',
      'Flourishing_End_Date',
      'Retirement_Date',
      'Death_Date',
      'Date_1',
      'Date_2',
    ],
    fieldAliases: {
      Maker_ID: ['ID'],
    },
    fieldTransforms: {
      Maker_ID: coerceMakerId,
    },
    keyFields: ['Maker_ID'],
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
  {
    name: 'instrumentTerms',
    endpoint: 'terms',
    csvFiles: ['vocabularies/instruments.csv'],
    fieldAliases: {
      term_id: ['ID'],
      preferred_label: ['Preferred_Label'],
      alternative_label_1: ['Alternative_Label 1'],
      alternative_label_2: ['Alternative_Label 2'],
      alternative_label_3: ['Alternative_Label 3'],
      alternative_label_4: ['Alternative_Label 4'],
      alternative_label_5: ['Alternative_Label 5'],
      alternative_label_6: ['Alternative_Label 6'],
      broader_1: ['Broader 1'],
      broader_1_id: ['Broader1_ID'],
      broader_2: ['Broader 2'],
      broader_2_id: ['Broader2_ID'],
      broader_3: ['Broader 3'],
      broader_3_id: ['Broader3_ID'],
      broader_4: ['Broader 4'],
      broader_4_id: ['Broader4_ID'],
      narrower: ['Narrower'],
      related_1: ['Related_1'],
      related_1_id: ['Related1_ID'],
      related_2: ['Related_2'],
      related_2_id: ['Related2_ID'],
      related_3: ['Related_3'],
      related_3_id: ['Related3_ID'],
      related_4: ['Related_4'],
      related_4_id: ['Related4_ID'],
      related_5: ['Related_5'],
      related_5_id: ['Related5_ID'],
      related_6: ['Related_6'],
      related_6_id: ['Related6_ID'],
      related_7: ['Related_7'],
      related_7_id: ['Related7_ID'],
      related_8: ['Related_8'],
      related_8_id: ['Related8_ID'],
      wikidata_uri: ['Wikidata_URI'],
      aat_uri: ['AAT_URI'],
      additional_information: ['Additional_Information'],
    },
    excludeFields: INSTRUMENT_TERM_SOURCE_HEADERS,
    keyFields: ['term_id'],
  },
];

const RELATION_LINKS = [
  {
    sourceEndpoint: 'addresses',
    targetEndpoint: 'addresses',
    sourceIdField: 'maker_id',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
    targetLookupEndpoint: 'makers-extended',
  },
  {
    sourceEndpoint: 'addresses',
    targetEndpoint: 'addresses',
    sourceIdField: 'town_location_id',
    targetIdField: 'town_location_id',
    connectionField: 'town_location',
    targetLookupEndpoint: 'town-locations',
  },
  {
    sourceEndpoint: 'memberships',
    targetEndpoint: 'memberships',
    sourceIdField: 'maker_id',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
    targetLookupEndpoint: 'makers-extended',
  },
  {
    sourceEndpoint: 'memberships',
    targetEndpoint: 'memberships',
    sourceIdField: 'guild_id',
    targetIdField: 'guild_id',
    connectionField: 'guild',
    targetLookupEndpoint: 'guilds',
  },
  {
    sourceEndpoint: 'relations',
    targetEndpoint: 'relations',
    sourceIdField: 'maker_id',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
    targetLookupEndpoint: 'makers-extended',
  },
  {
    sourceEndpoint: 'instruments-known',
    targetEndpoint: 'instruments-known',
    sourceIdField: 'maker_id',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
    targetLookupEndpoint: 'makers-extended',
  },
  {
    sourceEndpoint: 'instruments-advertised',
    targetEndpoint: 'instruments-advertised',
    sourceIdField: 'maker_id',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
    targetLookupEndpoint: 'makers-extended',
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

function coerceMakerId(value) {
  if (value === undefined || value === null) return value;

  if (typeof value === 'number') return value;

  const text = String(value).trim();
  if (!text) return null;

  const direct = Number.parseInt(text, 10);
  if (!Number.isNaN(direct)) return direct;

  const match = text.match(/^(?:M\s*[-_]?\s*)?(\d+)$/i);
  if (match) {
    return Number.parseInt(match[1], 10);
  }

  return value;
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

function castDateFields(record, dateFields = []) {
  const next = { ...record };

  for (const field of dateFields) {
    if (!(field in next)) continue;
    const value = next[field];
    if (value === null) {
      next[field] = null;
      continue;
    }

    const str = String(value).trim();
    if (!str) {
      next[field] = null;
      continue;
    }

    // If it's a 4-digit year, convert to YYYY-01-01
    if (/^\d{4}$/.test(str)) {
      next[field] = `${str}-01-01`;
      continue;
    }

    // If it's already in a date format (YYYY-MM-DD or similar), validate and keep it
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      next[field] = str;
      continue;
    }

    // Otherwise, treat as null
    next[field] = null;
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

function applyFieldAliases(record, fieldAliases = {}) {
  const next = { ...record };

  for (const [canonicalField, aliasFields] of Object.entries(fieldAliases)) {
    const aliases = Array.isArray(aliasFields) ? aliasFields : [aliasFields];

    if (next[canonicalField] !== null && next[canonicalField] !== undefined && next[canonicalField] !== '') {
      continue;
    }

    for (const alias of aliases) {
      if (next[alias] !== null && next[alias] !== undefined && next[alias] !== '') {
        next[canonicalField] = next[alias];
        break;
      }
    }
  }

  return next;
}

function applyFieldTransforms(record, fieldTransforms = {}) {
  const next = { ...record };

  for (const [field, transform] of Object.entries(fieldTransforms)) {
    if (!(field in next)) continue;
    if (typeof transform !== 'function') continue;

    next[field] = transform(next[field], next);
  }

  return next;
}

function normalizeRecord(row, config) {
  const withNulls = rowToRecord(row);
  const withAliases = applyFieldAliases(withNulls, config.fieldAliases);
  const withTransforms = applyFieldTransforms(withAliases, config.fieldTransforms);
  const withIntegers = castIntegerFields(withTransforms, config.integerFields);
  const withDates = castDateFields(withIntegers, config.dateFields);
  return removeExcludedFields(withDates, config.excludeFields);
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

  return parsed.map((row, index) => ({
    ...normalizeRecord(row, config),
    __csvFile: path.basename(csvPath),
    __csvRowNumber: index + 2,
  }));
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

function stripInternalFields(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith('__'))
  );
}

function formatRecordContext(record, fields = []) {
  const context = {};

  if (record?.__csvFile) {
    context.csvFile = record.__csvFile;
  }

  if (record?.__csvRowNumber) {
    context.csvRowNumber = record.__csvRowNumber;
  }

  const documentId = getDocumentId(record);
  if (documentId) {
    context.documentId = documentId;
  }

  if (fields.length) {
    context.fields = Object.fromEntries(fields.map((field) => [field, getFieldValue(record, field)]));
  }

  return JSON.stringify(context);
}

function logSkip(message) {
  if (options.verboseSkips) {
    console.warn(message);
  }
}

const integrityReport = {
  relationLinks: [],
  targetMakerLink: null,
  targetMakerBackfill: null,
};

const missingTargetsReport = {
  byEndpointAndField: {},
};

function trackMissingTarget(endpoint, fieldName, value) {
  if (!options.reportMissingTargets) return;
  const key = `${endpoint}::${fieldName}`;
  if (!missingTargetsReport.byEndpointAndField[key]) {
    missingTargetsReport.byEndpointAndField[key] = new Map();
  }
  const counts = missingTargetsReport.byEndpointAndField[key];
  counts.set(value, (counts.get(value) || 0) + 1);
}

function printMissingTargetsReport() {
  const entries = Object.entries(missingTargetsReport.byEndpointAndField);
  if (!entries.length) {
    console.log('[missing-targets] no missing targets reported.');
    return;
  }

  console.log('[missing-targets] report:');
  for (const [key, counts] of entries) {
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);
    const ids = sorted.map(([id]) => id).join(', ');
    const uniqueCount = counts.size;
    console.log(`[missing-targets] ${key}: ${uniqueCount} unique missing, top 50: [${ids}]`);
  }
}

function addRelationIntegrityEntry(entry) {
  integrityReport.relationLinks.push(entry);
}

function setTargetMakerIntegrityEntry(entry) {
  integrityReport.targetMakerLink = entry;
}

function setTargetMakerBackfillIntegrityEntry(entry) {
  integrityReport.targetMakerBackfill = entry;
}

function printIntegrityReport() {
  if (!integrityReport.relationLinks.length && !integrityReport.targetMakerLink && !integrityReport.targetMakerBackfill) {
    console.log('[integrity] no relation linking steps executed.');
    return {
      totalConnected: 0,
      totalSkipped: 0,
      totalExpectedSkipped: 0,
      totalProblematicSkipped: 0,
      totalFailed: 0,
      hasIssues: false,
    };
  }

  console.log('[integrity] relation linking report:');

  let totalConnected = 0;
  let totalSkipped = 0;
  let totalExpectedSkipped = 0;
  let totalProblematicSkipped = 0;
  let totalFailed = 0;

  for (const entry of integrityReport.relationLinks) {
    const expectedSkipped = entry.expectedSkipped ?? 0;
    const problematicSkipped = entry.problematicSkipped ?? entry.skipped ?? 0;
    totalConnected += entry.connected;
    totalSkipped += entry.skipped;
    totalExpectedSkipped += expectedSkipped;
    totalProblematicSkipped += problematicSkipped;
    totalFailed += entry.failed;
    console.log(
      `[integrity] ${entry.name}: sourceRows=${entry.sourceRows}, connected=${entry.connected}, skipped=${entry.skipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=${entry.failed}`
    );
  }

  if (integrityReport.targetMakerLink) {
    const entry = integrityReport.targetMakerLink;
    const expectedSkipped = entry.expectedSkipped ?? 0;
    const problematicSkipped = entry.problematicSkipped ?? entry.skipped ?? 0;
    totalConnected += entry.connected;
    totalSkipped += entry.skipped;
    totalExpectedSkipped += expectedSkipped;
    totalProblematicSkipped += problematicSkipped;
    totalFailed += entry.failed;
    console.log(
      `[integrity] ${entry.name}: sourceRows=${entry.sourceRows}, connected=${entry.connected}, skipped=${entry.skipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=${entry.failed}`
    );
  }

  if (integrityReport.targetMakerBackfill) {
    const entry = integrityReport.targetMakerBackfill;
    const expectedSkipped = entry.expectedSkipped ?? 0;
    const problematicSkipped = entry.problematicSkipped ?? entry.skipped ?? 0;
    totalConnected += entry.connected;
    totalSkipped += entry.skipped;
    totalExpectedSkipped += expectedSkipped;
    totalProblematicSkipped += problematicSkipped;
    totalFailed += entry.failed;
    console.log(
      `[integrity] ${entry.name}: candidates=${entry.sourceRows}, connected=${entry.connected}, skipped=${entry.skipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=${entry.failed}`
    );
  }

  console.log(
    `[integrity] totals: connected=${totalConnected}, skipped=${totalSkipped} (expected=${totalExpectedSkipped}, problematic=${totalProblematicSkipped}), failed=${totalFailed}`
  );

  return {
    totalConnected,
    totalSkipped,
    totalExpectedSkipped,
    totalProblematicSkipped,
    totalFailed,
    hasIssues: totalProblematicSkipped > 0 || totalFailed > 0,
  };
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
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          query.append(`${key}[${index}]`, String(item));
        });
        continue;
      }

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

async function deleteAllRecords(config) {
  const strapiRows = await fetchAll(config.endpoint);

  let deleted = 0;

  for (const row of strapiRows) {
    const documentId = getDocumentId(row);
    if (!documentId) continue;

    await deleteEntry(config.endpoint, documentId);
    deleted += 1;
  }

  console.log(`[delete] ${config.endpoint}: removed ${deleted} existing records`);
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
        logSkip(
          `[skip] ${config.endpoint}: missing key fields [${config.keyFields.join(', ')}] ${formatRecordContext(row, config.keyFields)}`
        );
        skipped += 1;
        continue;
      }

      if (processedInputKeys.has(rowKey)) {
        logSkip(
          `[skip] ${config.endpoint}: duplicate input key ${JSON.stringify(rowKey)} ${formatRecordContext(row, config.keyFields)}`
        );
        skippedDuplicateInput += 1;
        continue;
      }
      processedInputKeys.add(rowKey);

      const existingDocumentId = existingKeyToDocumentId.get(rowKey);
      const payload = stripInternalFields(row);

      if (existingDocumentId) {
        await updateEntry(config.endpoint, existingDocumentId, payload);
        updated += 1;
      } else {
        const createdPayload = await createEntry(config.endpoint, payload);
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

function normalizeTermId(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeCsvText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function getRelationDocumentId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return null;
  if (value.documentId) return value.documentId;
  if (value.data?.documentId) return value.data.documentId;
  return null;
}

async function ensureInstrumentsVocabulary() {
  const vocabularies = await fetchAll('vocabularies');
  const existing = vocabularies.find((row) => {
    const slug = getFieldValue(row, 'slug');
    const name = String(getFieldValue(row, 'name') || '').trim().toLowerCase();
    return slug === 'instruments' || name === 'instruments';
  });

  const existingDocumentId = getDocumentId(existing);
  if (existingDocumentId) return existingDocumentId;

  if (options.dryRun) {
    console.log('[terms] dry-run: vocabulary "instruments" does not exist and will not be created.');
    return null;
  }

  await createEntry('vocabularies', { name: 'Instruments', slug: 'instruments' });

  const reloaded = await fetchAll('vocabularies');
  const created = reloaded.find((row) => getFieldValue(row, 'slug') === 'instruments');
  return getDocumentId(created);
}

async function enrichInstrumentTerms() {
  const termsConfig = COLLECTIONS.find((config) => config.endpoint === 'terms');
  if (!termsConfig) return;

  const vocabularyDocumentId = await ensureInstrumentsVocabulary();
  if (!vocabularyDocumentId) return;

  const rows = readCsvRecords(termsConfig, options.csvDir);
  const csvByTermId = new Map();
  for (const row of rows) {
    const termId = normalizeTermId(row.term_id);
    if (!termId || csvByTermId.has(termId)) continue;
    csvByTermId.set(termId, row);
  }

  const termRows = await fetchAll('terms');
  const termDocumentIdByTermId = new Map();
  for (const row of termRows) {
    const termId = normalizeTermId(getFieldValue(row, 'term_id'));
    const documentId = getDocumentId(row);
    if (!termId || !documentId || termDocumentIdByTermId.has(termId)) continue;
    termDocumentIdByTermId.set(termId, documentId);
  }

  let updated = 0;
  let missingDocument = 0;
  let missingParent = 0;

  for (const [termId, row] of csvByTermId.entries()) {
    const termDocumentId = termDocumentIdByTermId.get(termId);
    if (!termDocumentId) {
      missingDocument += 1;
      continue;
    }

    const broaderCandidates = INSTRUMENT_TERM_BROADER_ID_FIELDS
      .map((field) => normalizeTermId(row[field]))
      .filter(Boolean);
    const parentDocumentId = broaderCandidates
      .map((candidate) => termDocumentIdByTermId.get(candidate))
      .find(Boolean);
    if (broaderCandidates.length > 0 && !parentDocumentId) {
      missingParent += 1;
    }

    const relatedDocumentIds = [...new Set(
      INSTRUMENT_TERM_RELATED_ID_FIELDS
        .map((field) => normalizeTermId(row[field]))
        .filter(Boolean)
        .map((value) => termDocumentIdByTermId.get(value))
        .filter(Boolean)
        .filter((value) => value !== termDocumentId)
    )];

    const data = {
      vocabulary: { connect: [vocabularyDocumentId] },
      related_terms: { set: relatedDocumentIds },
    };

    if (parentDocumentId) {
      data.parent = { connect: [parentDocumentId] };
    } else if (broaderCandidates.length === 0) {
      data.parent = null;
    }

    await updateEntry('terms', termDocumentId, data);
    updated += 1;
  }

  console.log(`[terms] instruments enrich: ${updated} updated, ${missingDocument} missing term documents, ${missingParent} missing parent links`);
}

async function syncInstrumentMakerTermAssociations() {
  const knownConfig = COLLECTIONS.find((config) => config.endpoint === 'instruments-known');
  const advertisedConfig = COLLECTIONS.find((config) => config.endpoint === 'instruments-advertised');
  if (!knownConfig || !advertisedConfig) return;

  const makerRows = await fetchAll('makers-extended', { fields: ['Maker_ID'] });
  const termRows = await fetchAll('terms', { fields: ['term_id'] });

  const makerDocumentIdByMakerId = new Map();
  for (const maker of makerRows) {
    const makerId = normalizeTermId(getFieldValue(maker, 'Maker_ID'));
    const documentId = getDocumentId(maker);
    if (!makerId || !documentId || makerDocumentIdByMakerId.has(makerId)) continue;
    makerDocumentIdByMakerId.set(makerId, documentId);
  }

  const termDocumentIdByTermId = new Map();
  for (const term of termRows) {
    const termId = normalizeTermId(getFieldValue(term, 'term_id'));
    const documentId = getDocumentId(term);
    if (!termId || !documentId || termDocumentIdByTermId.has(termId)) continue;
    termDocumentIdByTermId.set(termId, documentId);
  }

  const desiredByKey = new Map();
  const missingStats = {
    missingMakerId: 0,
    missingTermId: 0,
    makerNotFound: 0,
    termNotFound: 0,
  };

  const collectDesired = (rows, associationType) => {
    for (const row of rows) {
      const makerId = normalizeTermId(row.maker_id);
      const termId = normalizeTermId(row.inst_code);
      if (!makerId) {
        missingStats.missingMakerId += 1;
        continue;
      }
      if (!termId) {
        missingStats.missingTermId += 1;
        continue;
      }

      const makerDocumentId = makerDocumentIdByMakerId.get(makerId);
      if (!makerDocumentId) {
        missingStats.makerNotFound += 1;
        continue;
      }

      const termDocumentId = termDocumentIdByTermId.get(termId);
      if (!termDocumentId) {
        missingStats.termNotFound += 1;
        continue;
      }

      const key = `${makerDocumentId}::${termDocumentId}::${associationType}`;
      if (!desiredByKey.has(key)) {
        desiredByKey.set(key, {
          makerDocumentId,
          termDocumentId,
          associationType,
          evidenceLabel: normalizeCsvText(row.inst_name),
        });
      }
    }
  };

  collectDesired(readCsvRecords(knownConfig, options.csvDir), 'KNOWN');
  collectDesired(readCsvRecords(advertisedConfig, options.csvDir), 'ADVERTISED');

  const associationRows = await fetchAll('maker-term-associations', {
    'fields[0]': 'association_type',
    'fields[1]': 'evidence_label',
    'populate[maker_extended][fields][0]': 'documentId',
    'populate[term][fields][0]': 'documentId',
  });

  const existingByKey = new Map();
  for (const row of associationRows) {
    const associationDocumentId = getDocumentId(row);
    const makerDocumentId = getRelationDocumentId(getFieldValue(row, 'maker_extended') ?? row?.maker_extended);
    const termDocumentId = getRelationDocumentId(getFieldValue(row, 'term') ?? row?.term);
    const associationType = normalizeCsvText(getFieldValue(row, 'association_type'));
    if (!associationDocumentId || !makerDocumentId || !termDocumentId || !associationType) continue;

    const key = `${makerDocumentId}::${termDocumentId}::${associationType}`;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, {
        documentId: associationDocumentId,
        evidenceLabel: normalizeCsvText(getFieldValue(row, 'evidence_label')),
      });
    }
  }

  let created = 0;
  let updated = 0;

  for (const [key, desired] of desiredByKey.entries()) {
    const existing = existingByKey.get(key);
    if (existing) {
      if (existing.evidenceLabel !== desired.evidenceLabel) {
        await updateEntry('maker-term-associations', existing.documentId, {
          evidence_label: desired.evidenceLabel,
        });
        updated += 1;
      }
      continue;
    }

    await createEntry('maker-term-associations', {
      maker_extended: { connect: [desired.makerDocumentId] },
      term: { connect: [desired.termDocumentId] },
      association_type: desired.associationType,
      evidence_label: desired.evidenceLabel,
    });
    created += 1;
  }

  console.log(
    `[associations] maker-term-associations: ${created} created, ${updated} updated, skipped missing maker_id=${missingStats.missingMakerId}, missing inst_code=${missingStats.missingTermId}, maker not found=${missingStats.makerNotFound}, term not found=${missingStats.termNotFound}`
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

async function clearAllRelations(selectedEndpoints = null) {
  const relationFieldsToClear = {};
  for (const linkConfig of RELATION_LINKS) {
    if (selectedEndpoints && !selectedEndpoints.has(linkConfig.sourceEndpoint)) {
      continue;
    }

    const endpoint = linkConfig.sourceEndpoint;
    const field = linkConfig.connectionField;
    if (!relationFieldsToClear[endpoint]) {
      relationFieldsToClear[endpoint] = [];
    }
    if (!relationFieldsToClear[endpoint].includes(field)) {
      relationFieldsToClear[endpoint].push(field);
    }
  }

  if ((!selectedEndpoints || selectedEndpoints.has('relations')) && !relationFieldsToClear.relations) {
    relationFieldsToClear.relations = [];
  }
  if ((!selectedEndpoints || selectedEndpoints.has('relations')) && !relationFieldsToClear.relations.includes('target_maker_extended')) {
    relationFieldsToClear.relations.push('target_maker_extended');
  }

  for (const [endpoint, fieldsToClean] of Object.entries(relationFieldsToClear)) {
    const records = await fetchAll(endpoint);
    let cleared = 0;
    let failed = 0;

    for (const record of records) {
      const docId = getDocumentId(record);
      if (!docId) continue;

      const updateData = {};
      for (const field of fieldsToClean) {
        updateData[field] = { disconnect: [] };
      }

      try {
        if (!options.dryRun) {
          await updateEntry(endpoint, docId, updateData);
        }
        cleared += 1;
      } catch (error) {
        failed += 1;
        console.error(`[clear] ${endpoint}::${docId} failed: ${error.message}`);
      }
    }

    console.log(`[clear] ${endpoint}: cleared ${fieldsToClean.join(', ')} for ${cleared} records (${failed} failed)`);
  }
}

async function connectRelation(linkConfig) {
  const sourceRows = await fetchAll(linkConfig.sourceEndpoint, {
    fields: [linkConfig.sourceIdField],
  });
  const lookupEndpoint = linkConfig.targetLookupEndpoint || linkConfig.targetEndpoint;
  const targetRows = await fetchAll(lookupEndpoint, {
    fields: [linkConfig.targetIdField],
  });
  const targetMap = makeMapByField(targetRows, linkConfig.targetIdField);
  const relationSourceRows = options.relationLimit
    ? sourceRows.slice(0, options.relationLimit)
    : sourceRows;

  const targetRowsMissingField = targetRows.filter((row) => getFieldValue(row, linkConfig.targetIdField) === null).length;
  if (targetRows.length && !targetMap.size) {
    console.warn(
      `[debug] ${lookupEndpoint}: fetched ${targetRows.length} rows but none exposed ${JSON.stringify(linkConfig.targetIdField)}. Relation matching will skip until that field is returned by the API.`
    );
  } else if (targetRowsMissingField > 0) {
    console.warn(
      `[debug] ${lookupEndpoint}: ${targetRowsMissingField}/${targetRows.length} rows are missing ${JSON.stringify(linkConfig.targetIdField)} in API responses.`
    );
  }

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingSourceDocumentId = 0;
  let skippedMissingForeignKey = 0;
  let skippedMissingTarget = 0;

  for (let start = 0; start < relationSourceRows.length; start += options.relationBatchSize) {
    const batch = relationSourceRows.slice(start, start + options.relationBatchSize);

    for (const sourceRow of batch) {
      const sourceDocumentId = getDocumentId(sourceRow);
      const sourceForeignKey = getFieldValue(sourceRow, linkConfig.sourceIdField);

      if (!sourceDocumentId) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: missing source documentId or foreign key ${formatRecordContext(sourceRow, [linkConfig.sourceIdField])}`
        );
        skipped += 1;
        skippedMissingSourceDocumentId += 1;
        continue;
      }

      if (sourceForeignKey === null || sourceForeignKey === undefined) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: missing source documentId or foreign key ${formatRecordContext(sourceRow, [linkConfig.sourceIdField])}`
        );
        skipped += 1;
        skippedMissingForeignKey += 1;
        continue;
      }

      const targetDocumentIds = targetMap.get(String(sourceForeignKey));
      if (!targetDocumentIds || !targetDocumentIds.length) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: no target found for ${JSON.stringify(linkConfig.sourceIdField)}=${JSON.stringify(sourceForeignKey)} ${formatRecordContext(sourceRow, [linkConfig.sourceIdField])}`
        );
        trackMissingTarget(linkConfig.targetLookupEndpoint || linkConfig.targetEndpoint, linkConfig.targetIdField, sourceForeignKey);
        skipped += 1;
        skippedMissingTarget += 1;
        continue;
      }

      for (const targetDocumentId of targetDocumentIds) {
        try {
          await updateEntry(linkConfig.targetEndpoint, sourceDocumentId, {
            [linkConfig.connectionField]: {
              connect: [targetDocumentId],
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

  addRelationIntegrityEntry({
    name: `${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint} (${linkConfig.connectionField})`,
    sourceRows: relationSourceRows.length,
    connected,
    skipped,
    expectedSkipped: skippedMissingForeignKey,
    problematicSkipped: skippedMissingSourceDocumentId + skippedMissingTarget,
    skipBreakdown: {
      missingSourceDocumentId: skippedMissingSourceDocumentId,
      missingForeignKey: skippedMissingForeignKey,
      missingTarget: skippedMissingTarget,
    },
    failed,
  });
}

async function connectTargetMakers() {
  // target_maker_id is now a stored field on relation records, so we can drive
  // this pass entirely from the API without re-reading the CSV.
  const allRelationRows = await fetchAll('relations', {
    fields: ['relation_id', 'target_maker_id'],
  });
  const relationSourceRows = options.relationLimit
    ? allRelationRows.slice(0, options.relationLimit)
    : allRelationRows;

  const makerExtendedRows = await fetchAll('makers-extended', {
    fields: ['Maker_ID'],
  });
  const makerExtendedMap = makeMapByField(makerExtendedRows, 'Maker_ID');

  if (makerExtendedRows.length && !makerExtendedMap.size) {
    console.warn(
      '[debug] makers-extended: fetched rows but none exposed "Maker_ID". target_maker_extended matching will skip until that field is returned by the API.'
    );
  }

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingTargetMakerId = 0;
  let skippedMissingRelationDocumentId = 0;
  let skippedMissingMakerExtended = 0;

  for (let start = 0; start < relationSourceRows.length; start += options.relationBatchSize) {
    const batch = relationSourceRows.slice(start, start + options.relationBatchSize);

    for (const relationRow of batch) {
      const targetMakerId = getFieldValue(relationRow, 'target_maker_id');
      const relationDocumentId = getDocumentId(relationRow);

      if (!relationDocumentId) {
        logSkip(
          `[skip] relations -> makers-extended (target_maker_extended): missing target_maker_id or relation documentId ${formatRecordContext(relationRow, ['target_maker_id', 'relation_id'])}`
        );
        skipped += 1;
        skippedMissingRelationDocumentId += 1;
        continue;
      }

      if (targetMakerId === null || targetMakerId === undefined) {
        logSkip(
          `[skip] relations -> makers-extended (target_maker_extended): missing target_maker_id or relation documentId ${formatRecordContext(relationRow, ['target_maker_id', 'relation_id'])}`
        );
        skipped += 1;
        skippedMissingTargetMakerId += 1;
        continue;
      }

      const makerExtendedDocumentIds = makerExtendedMap.get(String(targetMakerId));
      const makerExtendedDocumentId = makerExtendedDocumentIds?.[0];

      if (!makerExtendedDocumentId) {
        logSkip(
          `[skip] relations -> makers-extended (target_maker_extended): no maker-extended found for target_maker_id=${JSON.stringify(targetMakerId)} ${formatRecordContext(relationRow, ['target_maker_id', 'relation_id'])}`
        );
        trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
        skipped += 1;
        skippedMissingMakerExtended += 1;
        continue;
      }

      try {
        await updateEntry('relations', relationDocumentId, {
          target_maker_extended: {
            connect: [makerExtendedDocumentId],
          },
        });
        connected += 1;
      } catch (error) {
        failed += 1;
        console.error(`[connect] relations.target_maker_id -> relations.target_maker_extended failed: ${error.message}`);
      }
    }

    console.log(
      `[connect] relations -> makers-extended (target_maker_extended): processed ${Math.min(start + batch.length, relationSourceRows.length)}/${relationSourceRows.length} source rows`
    );
  }

  console.log(
    `[connect] relations -> makers-extended (target_maker_extended): ${connected} connected, ${skipped} skipped, ${failed} failed`
  );

  setTargetMakerIntegrityEntry({
    name: 'relations -> makers-extended (target_maker_extended)',
    sourceRows: relationSourceRows.length,
    connected,
    skipped,
    expectedSkipped: skippedMissingTargetMakerId,
    problematicSkipped: skippedMissingRelationDocumentId + skippedMissingMakerExtended,
    skipBreakdown: {
      missingRelationDocumentId: skippedMissingRelationDocumentId,
      missingTargetMakerId: skippedMissingTargetMakerId,
      missingMakerExtended: skippedMissingMakerExtended,
    },
    failed,
  });
}

async function backfillMissingTargetMakersExtended() {
  const relationRows = await fetchAll('relations', {
    fields: ['relation_id', 'target_maker_id'],
    populate: ['target_maker_extended'],
  });

  const makerExtendedRows = await fetchAll('makers-extended', {
    fields: ['Maker_ID'],
  });
  const makerExtendedMap = makeMapByField(makerExtendedRows, 'Maker_ID');

  const candidates = relationRows.filter((row) => {
    const targetMakerId = getFieldValue(row, 'target_maker_id');
    const existingLink = getFieldValue(row, 'target_maker_extended');
    return targetMakerId !== null && targetMakerId !== undefined && !existingLink;
  });

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingRelationDocumentId = 0;
  let skippedMissingMakerExtended = 0;

  for (const relationRow of candidates) {
    const relationDocumentId = getDocumentId(relationRow);
    const targetMakerId = getFieldValue(relationRow, 'target_maker_id');

    if (!relationDocumentId) {
      skipped += 1;
      skippedMissingRelationDocumentId += 1;
      continue;
    }

    const makerExtendedDocumentIds = makerExtendedMap.get(String(targetMakerId));
    const makerExtendedDocumentId = makerExtendedDocumentIds?.[0];

    if (!makerExtendedDocumentId) {
      skipped += 1;
      trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
      skippedMissingMakerExtended += 1;
      continue;
    }

    try {
      await updateEntry('relations', relationDocumentId, {
        target_maker_extended: {
          connect: [makerExtendedDocumentId],
        },
      });
      connected += 1;
    } catch (error) {
      failed += 1;
      console.error(`[backfill] relations.target_maker_extended failed: ${error.message}`);
    }
  }

  console.log(
    `[backfill] relations.target_maker_extended: ${connected} connected, ${skipped} skipped, ${failed} failed (from ${candidates.length} candidates)`
  );

  setTargetMakerBackfillIntegrityEntry({
    name: 'relations.target_maker_extended backfill',
    sourceRows: candidates.length,
    connected,
    skipped,
    expectedSkipped: 0,
    problematicSkipped: skippedMissingRelationDocumentId + skippedMissingMakerExtended,
    skipBreakdown: {
      missingRelationDocumentId: skippedMissingRelationDocumentId,
      missingMakerExtended: skippedMissingMakerExtended,
    },
    failed,
  });
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
  if (options.skipRelations) {
    console.log('Relation linking: skipped');
  }
  if (options.collections?.size) {
    console.log(`Collections filter: ${[...options.collections].join(', ')}`);
  }
  console.log(`Relation batch size: ${options.relationBatchSize}`);
  if (options.relationLimit) {
    console.log(`Relation source limit: ${options.relationLimit}`);
  }
  if (options.dryRun) {
    console.log('Dry run enabled: no write operations will be sent.');
  }
  if (options.verboseSkips) {
    console.log('Verbose skip logging: enabled');
  }
  if (options.strictRelations) {
    console.log('Strict relations mode: enabled');
  }
  if (options.reportMissingTargets) {
    console.log('Missing targets reporting: enabled');
  }
  if (options.clearRelationsOnly) {
    console.log('Clear relations: enabled (will disconnect all relation fields before linking)');
  }

  const selectedCollections = options.collections
    ? COLLECTIONS.filter(
        (config) => options.collections.has(config.name) || options.collections.has(config.endpoint)
      )
    : COLLECTIONS;
  const selectedEndpoints = new Set(selectedCollections.map((config) => config.endpoint));

  if (options.collections?.size && !selectedCollections.length) {
    throw new Error(
      `No matching collections for --collections=${[...options.collections].join(',')}`
    );
  }

  if (options.strictRelations && (options.skipRelations || options.deleteOnly)) {
    throw new Error('--strict-relations requires relation linking to run (cannot be used with --skip-relations or --delete-only).');
  }

  if (!options.relationsOnly && (options.deleteExisting || options.deleteOnly)) {
    for (const config of selectedCollections) {
      await deleteAllRecords(config);
    }
  }

  if (!options.relationsOnly && !options.deleteOnly) {
    for (const config of selectedCollections) {
      await uploadCollection(config);
    }
  }

  const shouldProcessTerms = selectedCollections.some((config) => config.endpoint === 'terms');
  if (!options.deleteOnly && shouldProcessTerms) {
    await enrichInstrumentTerms();
  }

  const shouldProcessInstrumentAssociations = selectedCollections.some(
    (config) => config.endpoint === 'instruments-known' || config.endpoint === 'instruments-advertised' || config.endpoint === 'terms'
  );
  if (!options.deleteOnly && shouldProcessInstrumentAssociations) {
    await syncInstrumentMakerTermAssociations();
  }

  if (!options.deleteOnly && !options.skipRelations) {
    if (options.clearRelationsOnly) {
      await clearAllRelations(options.collections?.size ? selectedEndpoints : null);
    }

    const relationLinksToRun = options.collections?.size
      ? RELATION_LINKS.filter((linkConfig) => selectedEndpoints.has(linkConfig.sourceEndpoint))
      : RELATION_LINKS;

    for (const linkConfig of relationLinksToRun) {
      await connectRelation(linkConfig);
    }

    const shouldRunTargetMakerSteps = !options.collections?.size || selectedEndpoints.has('relations');
    if (shouldRunTargetMakerSteps) {
      await connectTargetMakers();
      await backfillMissingTargetMakersExtended();
    } else {
      console.log('[connect] relations -> makers-extended (target_maker_extended): skipped (relations not selected)');
    }

    const integritySummary = printIntegrityReport();
    if (options.reportMissingTargets) {
      printMissingTargetsReport();
    }
    if (options.strictRelations && integritySummary.hasIssues) {
      throw new Error(
        `[strict-relations] integrity check failed: ${integritySummary.totalProblematicSkipped} problematic skipped, ${integritySummary.totalFailed} failed relation links.`
      );
    }
  }

  console.log('CSV sync complete.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
