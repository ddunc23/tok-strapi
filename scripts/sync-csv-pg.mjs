import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import pg from 'pg';

const { Client } = pg;

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
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadEnvFiles() {
  const root = process.cwd();
  loadEnvFile(path.join(root, '.env'));
  loadEnvFile(path.join(root, '.env.local'));
}

loadEnvFiles();

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
  reportMissingTargets: hasFlag('--report-missing-targets'),
  csvDir: process.env.CSV_DIR || path.join(process.cwd(), 'data', 'csv'),
  collections: (() => {
    const value = getArgValue('--collections');
    if (!value) return null;
    const items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
    return items.length ? new Set(items) : null;
  })(),
  insertBatchSize: parsePositiveInt(getArgValue('--insert-batch-size') ?? process.env.SYNC_CSV_PG_INSERT_BATCH_SIZE, 500),
};

function rowValueToNullable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function coerceMakerId(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return null;
  const direct = Number.parseInt(text, 10);
  if (!Number.isNaN(direct)) return direct;
  const match = text.match(/^(?:M\s*[-_]?\s*)?(\d+)$/i);
  if (match) return Number.parseInt(match[1], 10);
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
    if (/^\d{4}$/.test(str)) {
      next[field] = `${str}-01-01`;
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      next[field] = str;
      continue;
    }
    next[field] = null;
  }
  return next;
}

function applyFieldAliases(record, fieldAliases = {}) {
  const next = { ...record };
  for (const [canonicalField, aliasFields] of Object.entries(fieldAliases)) {
    const aliases = Array.isArray(aliasFields) ? aliasFields : [aliasFields];
    if (next[canonicalField] !== null && next[canonicalField] !== undefined && next[canonicalField] !== '') continue;
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

function removeExcludedFields(record, excludeFields = []) {
  const next = { ...record };
  for (const field of excludeFields) delete next[field];
  return next;
}

function toDbColumnName(fieldName) {
  return fieldName.replace(/([A-Za-z])(\d+)/g, '$1_$2').toLowerCase();
}

function normalizeRecord(row, config) {
  const withNulls = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rowValueToNullable(value)]));
  const withAliases = applyFieldAliases(withNulls, config.fieldAliases);
  const withTransforms = applyFieldTransforms(withAliases, config.fieldTransforms);
  const withIntegers = castIntegerFields(withTransforms, config.integerFields);
  const withDates = castDateFields(withIntegers, config.dateFields);
  const cleaned = removeExcludedFields(withDates, config.excludeFields);
  const dbRecord = {};
  for (const [key, value] of Object.entries(cleaned)) {
    dbRecord[toDbColumnName(key)] = value;
  }
  return dbRecord;
}

function findCsvPath(csvDir, candidates) {
  for (const fileName of candidates) {
    const absolutePath = path.join(csvDir, fileName);
    if (fs.existsSync(absolutePath)) return absolutePath;
  }
  return null;
}

function readCsvRecords(config, csvDir) {
  const csvPath = findCsvPath(csvDir, config.csvFiles);
  if (!csvPath) throw new Error(`CSV not found for ${config.name}. Expected one of: ${config.csvFiles.join(', ')}`);
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

function stripInternalFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('__')));
}

function makeRecordKey(record, fields) {
  return fields.map((field) => {
    const value = record[field];
    return value === null || value === undefined ? '' : String(value);
  }).join('::');
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function makeDocumentId() {
  return crypto.randomBytes(12).toString('hex');
}

function logStepStart(label) {
  console.log(`[step] ${label}: start`);
}

function logStepEnd(label) {
  console.log(`[step] ${label}: done`);
}

function logProgress(label, processed, total) {
  const suffix = total ? `/${total}` : '';
  console.log(`[progress] ${label}: ${processed}${suffix}`);
}

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
    table: 'makers-extended',
    csvFiles: ['makers-extended-with-events.csv', 'maker-extended.csv', 'maker-extended-extract.csv'],
    integerFields: ['Maker_ID'],
    dateFields: ['Birth_Date', 'Establishment_Date', 'Working_Start_Date', 'Working_End_Date', 'Flourishing_Start_Date', 'Flourishing_End_Date', 'Retirement_Date', 'Death_Date', 'Date_1', 'Date_2'],
    fieldAliases: { Maker_ID: ['ID'] },
    fieldTransforms: { Maker_ID: coerceMakerId },
    keyColumns: ['maker_id'],
  },
  {
    name: 'points',
    table: 'points',
    csvFiles: ['point.csv'],
    fieldAliases: { Point_ID: ['id'] },
    excludeFields: ['id'],
    keyColumns: ['point_id'],
  },
  {
    name: 'addresses',
    table: 'addresses',
    csvFiles: ['address.csv'],
    integerFields: ['address_id', 'maker_id', 'town_location_id'],
    keyColumns: ['address_id'],
  },
  {
    name: 'townLocations',
    table: 'town_locations',
    csvFiles: ['town-location.csv'],
    integerFields: ['town_location_id'],
    keyColumns: ['town_location_id'],
  },
  {
    name: 'guilds',
    table: 'guilds',
    csvFiles: ['guild.csv'],
    integerFields: ['guild_id'],
    keyColumns: ['guild_id'],
  },
  {
    name: 'memberships',
    table: 'memberships',
    csvFiles: ['membership.csv'],
    integerFields: ['membership_id', 'guild_id', 'maker_id'],
    excludeFields: ['entry', 'entry_date_1', 'entry_date_2', 'uncertain', 'misc_codes', 'entry_date_1_certainty', 'entry_date_2_certainty'],
    keyColumns: ['membership_id'],
  },
  {
    name: 'relations',
    table: 'relations',
    csvFiles: ['relation.csv'],
    integerFields: ['maker_id', 'relation_code', 'relation_id', 'relation_type_id', 'target_maker_id'],
    excludeFields: ['relation_type_meta_id'],
    keyColumns: ['relation_id'],
  },
  {
    name: 'instrumentsKnown',
    table: 'instruments_known',
    csvFiles: ['instrument-known.csv', 'instrument_known.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyColumns: ['maker_id', 'inst_code', 'inst_name'],
  },
  {
    name: 'instrumentsAdvertised',
    table: 'instruments_advertised',
    csvFiles: ['instrument-advertised.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyColumns: ['maker_id', 'inst_code', 'inst_name'],
  },
  {
    name: 'sources',
    table: 'sources',
    csvFiles: ['sources.csv'],
    integerFields: ['maker_id'],
    excludeFields: ['maker_id'],
    keyColumns: ['sources_key', 'manuscripts', 'directories', 'other'],
  },
  {
    name: 'instrumentTerms',
    table: 'terms',
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
    keyColumns: ['term_id'],
  },
];

const POINT_MAKER_LINK_SOURCE = {
  name: 'pointMakerLinks',
  csvFiles: ['maker-point-links.csv'],
  fieldAliases: {
    Simon_ID: ['Simon ID'],
    Street_Address: ['Street Address'],
    Point_ID: ['Point ID'],
  },
  fieldTransforms: { Simon_ID: coerceMakerId },
  excludeFields: ['Street_Address'],
};

const SOURCES_LINK_SOURCE = {
  name: 'sourcesLinkRows',
  csvFiles: ['sources.csv'],
  integerFields: ['maker_id'],
};

const SOURCES_KEY_COLUMNS = ['sources_key', 'manuscripts', 'directories', 'other'];

const POINT_MAKER_LINK_TABLE = 'points_makers_lnk';

const RELATION_LINKS = [
  {
    label: 'addresses -> makers-extended (maker_extended)',
    sourceTable: 'addresses',
    sourceValueColumn: 'maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'addresses_maker_extended_lnk',
    sourceLinkColumn: 'address_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'address_ord',
  },
  {
    label: 'addresses -> town_locations (town_location)',
    sourceTable: 'addresses',
    sourceValueColumn: 'town_location_id',
    targetTable: 'town_locations',
    targetValueColumn: 'town_location_id',
    linkTable: 'addresses_town_location_lnk',
    sourceLinkColumn: 'address_id',
    targetLinkColumn: 'town_location_id',
    ordColumn: 'address_ord',
  },
  {
    label: 'memberships -> makers-extended (maker_extended)',
    sourceTable: 'memberships',
    sourceValueColumn: 'maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'memberships_maker_extended_lnk',
    sourceLinkColumn: 'membership_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'membership_ord',
  },
  {
    label: 'memberships -> guilds (guild)',
    sourceTable: 'memberships',
    sourceValueColumn: 'guild_id',
    targetTable: 'guilds',
    targetValueColumn: 'guild_id',
    linkTable: 'memberships_guild_lnk',
    sourceLinkColumn: 'membership_id',
    targetLinkColumn: 'guild_id',
    ordColumn: 'membership_ord',
  },
  {
    label: 'relations -> makers-extended (maker_extended)',
    sourceTable: 'relations',
    sourceValueColumn: 'maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'relations_maker_extended_lnk',
    sourceLinkColumn: 'relation_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'relation_ord',
  },
  {
    label: 'relations -> makers-extended (target_maker_extended)',
    sourceTable: 'relations',
    sourceValueColumn: 'target_maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'relations_target_maker_extended_lnk',
    sourceLinkColumn: 'relation_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'relation_ord',
  },
  {
    label: 'instruments_known -> makers-extended (maker_extended)',
    sourceTable: 'instruments_known',
    sourceValueColumn: 'maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'instruments_known_maker_extended_lnk',
    sourceLinkColumn: 'instrument_known_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'instrument_known_ord',
  },
  {
    label: 'instruments_advertised -> makers-extended (maker_extended)',
    sourceTable: 'instruments_advertised',
    sourceValueColumn: 'maker_id',
    targetTable: 'makers-extended',
    targetValueColumn: 'maker_id',
    linkTable: 'instruments_advertised_maker_extended_lnk',
    sourceLinkColumn: 'instrument_advertised_id',
    targetLinkColumn: 'maker_extended_id',
    ordColumn: 'instrument_advertised_ord',
  },
];

function getSelectedCollections() {
  const matchesCollectionToken = (config, token) => {
    const variants = new Set([
      config.name,
      config.table,
      String(config.table).replace(/_/g, '-'),
    ]);
    return variants.has(token);
  };

  return options.collections
    ? COLLECTIONS.filter((config) => [...options.collections].some((token) => matchesCollectionToken(config, token)))
    : COLLECTIONS;
}

function getHandledLinkTables() {
  return [...new Set([...RELATION_LINKS.map((link) => link.linkTable), POINT_MAKER_LINK_TABLE])];
}

async function queryMapByKeys(client, table, keyColumns) {
  const sql = `SELECT id, document_id, ${keyColumns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`;
  const res = await client.query(sql);
  const map = new Map();
  for (const row of res.rows) {
    const key = makeRecordKey(row, keyColumns);
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
}

async function insertBatch(client, table, rows) {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const values = [];
  const placeholders = [];
  let index = 1;

  for (const row of rows) {
    const tuple = [];
    for (const column of columns) {
      values.push(column in row ? row[column] : null);
      tuple.push(`$${index++}`);
    }
    placeholders.push(`(${tuple.join(', ')})`);
  }

  const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${placeholders.join(', ')}`;
  await client.query(sql, values);
}

async function updateRow(client, table, id, row) {
  const columns = Object.keys(row);
  const assignments = columns.map((column, idx) => `${quoteIdent(column)} = $${idx + 1}`);
  const values = columns.map((column) => row[column]);
  values.push(id);
  const sql = `UPDATE ${quoteIdent(table)} SET ${assignments.join(', ')} WHERE id = $${values.length}`;
  await client.query(sql, values);
}

async function truncateHandledTables(client, selectedCollections) {
  const label = 'truncate handled tables';
  logStepStart(label);
  const baseTables = selectedCollections.map((config) => config.table);
  const linkTables = getHandledLinkTables();
  const allTables = [...new Set([...linkTables, ...baseTables])];
  const sql = `TRUNCATE TABLE ${allTables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`;
  if (!options.dryRun) await client.query(sql);
  logStepEnd(label);
}

async function uploadCollection(client, config) {
  const label = `upload ${config.table}`;
  logStepStart(label);
  const csvRows = readCsvRecords(config, options.csvDir).map(stripInternalFields);
  const now = new Date();

  const existingMap = options.deleteExisting || options.deleteOnly || options.relationsOnly
    ? new Map()
    : await queryMapByKeys(client, config.table, config.keyColumns);

  const inserts = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let duplicate = 0;
  let failed = 0;
  const seenKeys = new Set();
  let processed = 0;

  for (const row of csvRows) {
    const key = makeRecordKey(row, config.keyColumns);
    if (!key) {
      skipped += 1;
      processed += 1;
      continue;
    }
    if (seenKeys.has(key)) {
      duplicate += 1;
      processed += 1;
      continue;
    }
    seenKeys.add(key);

    const existing = existingMap.get(key);
    try {
      if (existing) {
        const payload = { ...row, updated_at: now };
        if (!options.dryRun) await updateRow(client, config.table, existing.id, payload);
        updated += 1;
      } else {
        inserts.push({
          ...row,
          document_id: makeDocumentId(),
          created_at: now,
          updated_at: now,
          published_at: now,
        });
        if (inserts.length >= options.insertBatchSize) {
          if (!options.dryRun) await insertBatch(client, config.table, inserts.splice(0));
        }
        created += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`[upload] ${config.table} failed for key ${JSON.stringify(key)}: ${error.message}`);
    }

    processed += 1;
    if (processed % options.insertBatchSize === 0 || processed === csvRows.length) {
      logProgress(label, processed, csvRows.length);
    }
  }

  if (inserts.length && !options.dryRun) {
    await insertBatch(client, config.table, inserts);
  }

  console.log(`[upload] ${config.table}: ${created} created, ${updated} updated, ${skipped} skipped, ${duplicate} duplicate, ${failed} failed`);
  logStepEnd(label);
}

async function clearLinkTables(client) {
  const label = 'clear relation link tables';
  logStepStart(label);
  const tables = getHandledLinkTables();
  if (!options.dryRun) {
    await client.query(`TRUNCATE TABLE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY`);
  }
  logStepEnd(label);
}

async function countScalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  return Number(res.rows[0]?.count || 0);
}

async function getTableColumns(client, tableName) {
  const res = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return res.rows.map((row) => row.column_name);
}

async function hasColumn(client, tableName, columnName) {
  const res = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return res.rows.length > 0;
}

async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1
     LIMIT 1`,
    [tableName]
  );
  return res.rows.length > 0;
}

function normalizeTermId(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

async function resolveGenericLinkColumns(client, linkTable, { targetHint, sourceFallback, targetFallback, ordFallback }) {
  const columns = await getTableColumns(client, linkTable);
  const idColumns = columns.filter((column) => column.endsWith('_id'));

  const targetMatchers = [
    `${targetHint}_id`,
    `_${targetHint}_id`,
    `${targetHint}_`,
  ];

  const target =
    idColumns.find((column) => column === `${targetHint}_id`) ||
    idColumns.find((column) => column.endsWith(`_${targetHint}_id`)) ||
    idColumns.find((column) => column.startsWith(`${targetHint}_`)) ||
    idColumns.find((column) => !column.includes('association') && targetMatchers.some((token) => column.includes(token))) ||
    idColumns.find((column) => !column.includes('association') && column.includes(targetHint)) ||
    targetFallback;

  const source =
    idColumns.find((column) => column !== target && column.includes('association')) ||
    idColumns.find((column) => column !== target) ||
    sourceFallback;
  const ord = columns.find((column) => column.endsWith('_ord')) || ordFallback;

  if (!source || !target || !ord) {
    throw new Error(`Unable to resolve link columns for ${linkTable}. Found columns: ${columns.join(', ')}`);
  }

  return { source, target, ord };
}

async function ensureInstrumentsVocabulary(client) {
  const vocabTable = quoteIdent('vocabularies');
  const existing = await client.query(
    `SELECT id, document_id
     FROM ${vocabTable}
     WHERE slug = 'instruments' OR LOWER(name) = 'instruments'
     ORDER BY id
     LIMIT 1`
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  if (options.dryRun) {
    console.log('[terms] dry-run: vocabulary "instruments" does not exist and will not be created.');
    return null;
  }

  const now = new Date();
  const inserted = await client.query(
    `INSERT INTO ${vocabTable} (document_id, name, slug, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $4, $4)
     RETURNING id`,
    [makeDocumentId(), 'Instruments', 'instruments', now]
  );

  return inserted.rows[0]?.id ?? null;
}

async function enrichInstrumentTerms(client) {
  const termsConfig = COLLECTIONS.find((config) => config.table === 'terms');
  if (!termsConfig) return;

  const label = 'enrich terms (instruments vocabulary)';
  logStepStart(label);

  const vocabularyId = await ensureInstrumentsVocabulary(client);
  if (!vocabularyId) {
    logStepEnd(label);
    return;
  }

  const csvRows = readCsvRecords(termsConfig, options.csvDir).map(stripInternalFields);
  const csvByTermId = new Map();
  for (const row of csvRows) {
    const termId = normalizeTermId(row.term_id);
    if (!termId || csvByTermId.has(termId)) continue;
    csvByTermId.set(termId, row);
  }

  const termRes = await client.query(`SELECT id, term_id FROM ${quoteIdent('terms')} WHERE term_id IS NOT NULL`);
  const termRowIdByTermId = new Map();
  for (const row of termRes.rows) {
    const termId = normalizeTermId(row.term_id);
    if (!termId || termRowIdByTermId.has(termId)) continue;
    termRowIdByTermId.set(termId, row.id);
  }

  const termIds = [...csvByTermId.keys()]
    .map((termId) => termRowIdByTermId.get(termId))
    .filter((rowId) => Number.isInteger(rowId));

  if (!termIds.length) {
    console.log('[terms] instruments enrich: 0 matched terms found in table.');
    logStepEnd(label);
    return;
  }

  const now = new Date();

  if (await hasColumn(client, 'terms', 'vocabulary_id')) {
    if (!options.dryRun) {
      await client.query(
        `UPDATE ${quoteIdent('terms')}
         SET ${quoteIdent('vocabulary_id')} = $1,
             ${quoteIdent('updated_at')} = $2
         WHERE id = ANY($3::int[])`,
        [vocabularyId, now, termIds]
      );
    }
  } else if (await tableExists(client, 'terms_vocabulary_lnk')) {
    const linkColumns = await resolveGenericLinkColumns(client, 'terms_vocabulary_lnk', {
      targetHint: 'vocabulary',
      sourceFallback: 'term_id',
      targetFallback: 'vocabulary_id',
      ordFallback: 'term_ord',
    });

    if (!options.dryRun) {
      await client.query(
        `DELETE FROM ${quoteIdent('terms_vocabulary_lnk')} WHERE ${quoteIdent(linkColumns.source)} = ANY($1::int[])`,
        [termIds]
      );

      await client.query(
        `INSERT INTO ${quoteIdent('terms_vocabulary_lnk')} (${quoteIdent(linkColumns.source)}, ${quoteIdent(linkColumns.target)}, ${quoteIdent(linkColumns.ord)})
         SELECT UNNEST($1::int[]), $2::int, 1`,
        [termIds, vocabularyId]
      );
    }
  }

  const parentAssignments = [];
  const relatedAssignments = [];
  let missingParent = 0;

  for (const [termId, row] of csvByTermId.entries()) {
    const sourceRowId = termRowIdByTermId.get(termId);
    if (!sourceRowId) continue;

    const broaderCandidates = INSTRUMENT_TERM_BROADER_ID_FIELDS
      .map((field) => normalizeTermId(row[field]))
      .filter((value) => !!value);

    const parentRowId = broaderCandidates
      .map((candidate) => termRowIdByTermId.get(candidate))
      .find((candidate) => Number.isInteger(candidate)) || null;

    if (broaderCandidates.length > 0 && !parentRowId) {
      missingParent += 1;
    }

    parentAssignments.push({ sourceRowId, parentRowId });

    for (const relatedField of INSTRUMENT_TERM_RELATED_ID_FIELDS) {
      const relatedTermId = normalizeTermId(row[relatedField]);
      if (!relatedTermId) continue;
      const relatedRowId = termRowIdByTermId.get(relatedTermId);
      if (!relatedRowId || relatedRowId === sourceRowId) continue;
      relatedAssignments.push({ sourceRowId, relatedRowId });
    }
  }

  if (await hasColumn(client, 'terms', 'parent_id')) {
    if (!options.dryRun) {
      for (const assignment of parentAssignments) {
        await client.query(
          `UPDATE ${quoteIdent('terms')}
           SET ${quoteIdent('parent_id')} = $1,
               ${quoteIdent('updated_at')} = $2
           WHERE id = $3`,
          [assignment.parentRowId, now, assignment.sourceRowId]
        );
      }
    }
  } else if (await tableExists(client, 'terms_parent_lnk')) {
    const columns = await getTableColumns(client, 'terms_parent_lnk');
    const idColumns = columns.filter((column) => column.endsWith('_id'));
    const targetColumn = idColumns.find((column) => column.startsWith('inv_') || column.includes('parent')) || idColumns[1];
    const sourceColumn = idColumns.find((column) => column !== targetColumn) || idColumns[0];
    const ordColumn = columns.find((column) => column.endsWith('_ord')) || 'term_ord';

    if (!options.dryRun) {
      await client.query(
        `DELETE FROM ${quoteIdent('terms_parent_lnk')} WHERE ${quoteIdent(sourceColumn)} = ANY($1::int[])`,
        [parentAssignments.map((assignment) => assignment.sourceRowId)]
      );

      for (const assignment of parentAssignments) {
        if (!assignment.parentRowId) continue;
        await client.query(
          `INSERT INTO ${quoteIdent('terms_parent_lnk')} (${quoteIdent(sourceColumn)}, ${quoteIdent(targetColumn)}, ${quoteIdent(ordColumn)})
           VALUES ($1, $2, 1)`,
          [assignment.sourceRowId, assignment.parentRowId]
        );
      }
    }
  }

  if (await tableExists(client, 'terms_related_terms_lnk')) {
    const columns = await getTableColumns(client, 'terms_related_terms_lnk');
    const idColumns = columns.filter((column) => column.endsWith('_id'));
    const targetColumn = idColumns.find((column) => column.startsWith('inv_')) || idColumns[1];
    const sourceColumn = idColumns.find((column) => column !== targetColumn) || idColumns[0];
    const ordColumn = columns.find((column) => column.endsWith('_ord')) || 'term_ord';

    const deduped = [];
    const seen = new Set();
    for (const row of relatedAssignments) {
      const key = `${row.sourceRowId}::${row.relatedRowId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }

    if (!options.dryRun) {
      await client.query(
        `DELETE FROM ${quoteIdent('terms_related_terms_lnk')} WHERE ${quoteIdent(sourceColumn)} = ANY($1::int[])`,
        [parentAssignments.map((assignment) => assignment.sourceRowId)]
      );

      for (const row of deduped) {
        await client.query(
          `INSERT INTO ${quoteIdent('terms_related_terms_lnk')} (${quoteIdent(sourceColumn)}, ${quoteIdent(targetColumn)}, ${quoteIdent(ordColumn)})
           VALUES ($1, $2, 1)`,
          [row.sourceRowId, row.relatedRowId]
        );
      }
    }
  }

  console.log(`[terms] instruments enrich: ${termIds.length} matched terms, ${missingParent} missing parent links`);
  logStepEnd(label);
}

async function syncInstrumentMakerTermAssociationsPg(client) {
  const label = 'sync maker-term-associations (known/advertised instruments)';
  logStepStart(label);

  const desiredRes = await client.query(
    `SELECT DISTINCT
        m.id AS maker_row_id,
        t.id AS term_row_id,
        x.association_type,
        NULLIF(BTRIM(x.inst_name), '') AS evidence_label
     FROM (
       SELECT maker_id, inst_code, inst_name, 'KNOWN'::text AS association_type
       FROM ${quoteIdent('instruments_known')}
       UNION ALL
       SELECT maker_id, inst_code, inst_name, 'ADVERTISED'::text AS association_type
       FROM ${quoteIdent('instruments_advertised')}
     ) x
     JOIN ${quoteIdent('makers-extended')} m ON m.maker_id = x.maker_id
     JOIN ${quoteIdent('terms')} t ON t.term_id::text = x.inst_code::text
     WHERE x.maker_id IS NOT NULL AND x.inst_code IS NOT NULL`
  );

  const associationTable = 'maker_term_associations';
  const makerLinkTable = 'maker_term_associations_maker_extended_lnk';
  const termLinkTable = 'maker_term_associations_term_lnk';

  if (!(await tableExists(client, associationTable))) {
    console.log('[associations] maker_term_associations table not found, skipping association sync.');
    logStepEnd(label);
    return;
  }

  const makerLinkColumns = await resolveGenericLinkColumns(client, makerLinkTable, {
    targetHint: 'maker_extended',
    sourceFallback: 'maker_term_association_id',
    targetFallback: 'maker_extended_id',
    ordFallback: 'maker_term_association_ord',
  });

  const termLinkColumns = await resolveGenericLinkColumns(client, termLinkTable, {
    targetHint: 'term',
    sourceFallback: 'maker_term_association_id',
    targetFallback: 'term_id',
    ordFallback: 'maker_term_association_ord',
  });

  const existingRes = await client.query(
    `SELECT
        a.id AS association_id,
        a.association_type,
        a.evidence_label,
        mk.${quoteIdent(makerLinkColumns.target)} AS maker_row_id,
        tk.${quoteIdent(termLinkColumns.target)} AS term_row_id
     FROM ${quoteIdent(associationTable)} a
     JOIN ${quoteIdent(makerLinkTable)} mk ON mk.${quoteIdent(makerLinkColumns.source)} = a.id
     JOIN ${quoteIdent(termLinkTable)} tk ON tk.${quoteIdent(termLinkColumns.source)} = a.id`
  );

  const existingByKey = new Map();
  for (const row of existingRes.rows) {
    const key = `${row.maker_row_id}::${row.term_row_id}::${row.association_type}`;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, {
        associationId: row.association_id,
        evidenceLabel: normalizeText(row.evidence_label),
      });
    }
  }

  const now = new Date();
  let created = 0;
  let updated = 0;
  let processed = 0;

  for (const row of desiredRes.rows) {
    const key = `${row.maker_row_id}::${row.term_row_id}::${row.association_type}`;
    const existing = existingByKey.get(key);
    const evidenceLabel = normalizeText(row.evidence_label);

    if (existing) {
      if (existing.evidenceLabel !== evidenceLabel && !options.dryRun) {
        await client.query(
          `UPDATE ${quoteIdent(associationTable)}
           SET evidence_label = $1,
               updated_at = $2
           WHERE id = $3`,
          [evidenceLabel, now, existing.associationId]
        );
        updated += 1;
      }
    } else {
      if (!options.dryRun) {
        const insertRes = await client.query(
          `INSERT INTO ${quoteIdent(associationTable)}
             (document_id, association_type, evidence_label, created_at, updated_at, published_at)
           VALUES ($1, $2, $3, $4, $4, $4)
           RETURNING id`,
          [makeDocumentId(), row.association_type, evidenceLabel, now]
        );
        const associationId = insertRes.rows[0]?.id;

        await client.query(
          `INSERT INTO ${quoteIdent(makerLinkTable)} (${quoteIdent(makerLinkColumns.source)}, ${quoteIdent(makerLinkColumns.target)}, ${quoteIdent(makerLinkColumns.ord)})
           VALUES ($1, $2, 1)`,
          [associationId, row.maker_row_id]
        );

        await client.query(
          `INSERT INTO ${quoteIdent(termLinkTable)} (${quoteIdent(termLinkColumns.source)}, ${quoteIdent(termLinkColumns.target)}, ${quoteIdent(termLinkColumns.ord)})
           VALUES ($1, $2, 1)`,
          [associationId, row.term_row_id]
        );
      }
      created += 1;
    }

    processed += 1;
    if (processed % options.insertBatchSize === 0 || processed === desiredRes.rows.length) {
      logProgress(label, processed, desiredRes.rows.length);
    }
  }

  console.log(`[associations] maker-term-associations: ${created} created, ${updated} updated, desired=${desiredRes.rows.length}`);
  logStepEnd(label);
}

async function linkSourcesToMakers(client) {
  const label = 'link sources -> makers-extended';
  logStepStart(label);

  const csvRows = readCsvRecords(SOURCES_LINK_SOURCE, options.csvDir).map(stripInternalFields);
  const sourcesMap = await queryMapByKeys(client, 'sources', SOURCES_KEY_COLUMNS);

  const makerRes = await client.query(`SELECT id, maker_id FROM ${quoteIdent('makers-extended')} WHERE maker_id IS NOT NULL`);
  const makerMap = new Map();
  for (const row of makerRes.rows) {
    makerMap.set(Number(row.maker_id), row.id);
  }

  const seenKeys = new Set();
  const assignments = [];
  let expectedSkipped = 0;
  let duplicate = 0;
  let problematicSkipped = 0;

  for (const row of csvRows) {
    const makerId = row.maker_id;
    const sourceKey = makeRecordKey(row, SOURCES_KEY_COLUMNS);
    if (!makerId || !sourceKey) {
      expectedSkipped += 1;
      continue;
    }

    const dedupeKey = `${sourceKey}::${makerId}`;
    if (seenKeys.has(dedupeKey)) {
      duplicate += 1;
      continue;
    }
    seenKeys.add(dedupeKey);

    const sourceRow = sourcesMap.get(sourceKey);
    const makerRowId = makerMap.get(Number(makerId));
    if (!sourceRow || !makerRowId) {
      problematicSkipped += 1;
      continue;
    }

    assignments.push({ sourceId: sourceRow.id, makerExtendedId: makerRowId });
  }

  const dedupedAssignments = [];
  const assignedSourceIds = new Set();
  for (const item of assignments) {
    if (assignedSourceIds.has(item.sourceId)) continue;
    assignedSourceIds.add(item.sourceId);
    dedupedAssignments.push(item);
  }

  const sourceRows = csvRows.length;
  const connected = dedupedAssignments.length;

  if (dedupedAssignments.length && !options.dryRun) {
    const usesForeignKeyColumn = await hasColumn(client, 'sources', 'maker_extended_id');

    if (usesForeignKeyColumn) {
      const values = dedupedAssignments.flatMap((row) => [row.sourceId, row.makerExtendedId]);
      const valuesSql = dedupedAssignments
        .map((_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::integer)`)
        .join(', ');

      await client.query(
        `WITH updates(source_id, maker_extended_id) AS (VALUES ${valuesSql})
         UPDATE ${quoteIdent('sources')} s
         SET ${quoteIdent('maker_extended_id')} = u.maker_extended_id
         FROM updates u
         WHERE s.id = u.source_id`,
        values
      );
    } else {
      const linkTable = 'sources_maker_extended_lnk';
      const linkColumns = await getTableColumns(client, linkTable);
      const targetLinkColumn = linkColumns.find((column) => column.includes('maker_extended') && column.endsWith('_id')) || 'maker_extended_id';
      const sourceLinkColumn = linkColumns.find((column) => column.endsWith('_id') && column !== targetLinkColumn) || 'sources_id';
      const ordColumn = linkColumns.find((column) => column.endsWith('_ord')) || 'sources_ord';

      await client.query(`TRUNCATE TABLE ${quoteIdent(linkTable)} RESTART IDENTITY`);

      const values = dedupedAssignments.flatMap((row) => [row.sourceId, row.makerExtendedId]);
      const valuesSql = dedupedAssignments
        .map((_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::integer)`)
        .join(', ');

      await client.query(
        `WITH rows_to_link(source_id, maker_extended_id) AS (VALUES ${valuesSql})
         INSERT INTO ${quoteIdent(linkTable)} (${quoteIdent(sourceLinkColumn)}, ${quoteIdent(targetLinkColumn)}, ${quoteIdent(ordColumn)})
         SELECT source_id, maker_extended_id, 1
         FROM rows_to_link`,
        values
      );
    }
  }

  console.log(`[integrity] ${label}: sourceRows=${sourceRows}, connected=${connected}, skipped=${expectedSkipped + problematicSkipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), duplicate=${duplicate}, failed=0`);
  logStepEnd(label);

  return { label, sourceRows, connected, expectedSkipped, problematicSkipped, failed: 0 };
}

async function resolveDynamicLinkColumns(client, link) {
  if (!link.dynamicLinkColumns) return link;

  const res = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position`,
    [link.linkTable]
  );

  const columns = res.rows.map((row) => row.column_name);
  const targetLinkColumn = columns.find((column) => column.includes('maker_extended') && column.endsWith('_id')) || link.targetLinkColumn;
  const sourceLinkColumn = columns.find((column) => column.endsWith('_id') && column !== targetLinkColumn) || link.sourceLinkColumn;
  const ordColumn = columns.find((column) => column.endsWith('_ord')) || link.ordColumn;

  if (!sourceLinkColumn || !targetLinkColumn || !ordColumn) {
    throw new Error(`Unable to resolve dynamic link columns for ${link.linkTable}. Found columns: ${columns.join(', ')}`);
  }

  return {
    ...link,
    sourceLinkColumn,
    targetLinkColumn,
    ordColumn,
  };
}

async function linkRelations(client, link) {
  const resolvedLink = await resolveDynamicLinkColumns(client, link);
  const label = `link ${resolvedLink.label}`;
  logStepStart(label);

  const sourceTable = quoteIdent(resolvedLink.sourceTable);
  const targetTable = quoteIdent(resolvedLink.targetTable);
  const linkTable = quoteIdent(resolvedLink.linkTable);
  const sourceValueColumn = quoteIdent(resolvedLink.sourceValueColumn);
  const targetValueColumn = quoteIdent(resolvedLink.targetValueColumn);
  const sourceLinkColumn = quoteIdent(resolvedLink.sourceLinkColumn);
  const targetLinkColumn = quoteIdent(resolvedLink.targetLinkColumn);
  const ordColumn = quoteIdent(resolvedLink.ordColumn);

  const sourceRows = await countScalar(client, `SELECT COUNT(*) FROM ${sourceTable}`);
  const expectedSkipped = await countScalar(client, `SELECT COUNT(*) FROM ${sourceTable} s WHERE s.${sourceValueColumn} IS NULL`);
  const problematicSkipped = await countScalar(
    client,
    `SELECT COUNT(*) FROM ${sourceTable} s WHERE s.${sourceValueColumn} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetValueColumn} = s.${sourceValueColumn})`
  );
  const connected = await countScalar(
    client,
    `SELECT COUNT(*) FROM ${sourceTable} s JOIN ${targetTable} t ON t.${targetValueColumn} = s.${sourceValueColumn} WHERE s.${sourceValueColumn} IS NOT NULL`
  );

  if (options.reportMissingTargets) {
    const res = await client.query(
      `SELECT s.${sourceValueColumn} AS missing_value, COUNT(*) AS n
       FROM ${sourceTable} s
       WHERE s.${sourceValueColumn} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${targetTable} t WHERE t.${targetValueColumn} = s.${sourceValueColumn})
       GROUP BY s.${sourceValueColumn}
       ORDER BY COUNT(*) DESC, s.${sourceValueColumn}
       LIMIT 50`
    );
    if (res.rows.length) {
      console.log(`[missing-targets] ${resolvedLink.targetTable}::${resolvedLink.targetValueColumn.replace(/"/g, '')}: ${res.rows.map((r) => r.missing_value).join(', ')}`);
    }
  }

  const insertSql = `
    INSERT INTO ${linkTable} (${sourceLinkColumn}, ${targetLinkColumn}, ${ordColumn})
    SELECT s.id, t.id, 1
    FROM ${sourceTable} s
    JOIN ${targetTable} t ON t.${targetValueColumn} = s.${sourceValueColumn}
    WHERE s.${sourceValueColumn} IS NOT NULL
  `;

  if (!options.dryRun) await client.query(insertSql);

  console.log(`[integrity] ${resolvedLink.label}: sourceRows=${sourceRows}, connected=${connected}, skipped=${expectedSkipped + problematicSkipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=0`);
  logStepEnd(label);

  return { label: resolvedLink.label, sourceRows, connected, expectedSkipped, problematicSkipped, failed: 0 };
}

async function linkPointsToMakers(client) {
  const label = 'link points -> makers-extended';
  logStepStart(label);

  const csvRows = readCsvRecords(POINT_MAKER_LINK_SOURCE, options.csvDir).map(stripInternalFields);
  const seenKeys = new Set();
  const uniqueRows = [];
  let expectedSkipped = 0;
  let duplicate = 0;

  for (const row of csvRows) {
    const makerId = row.simon_id;
    const pointId = row.point_id;
    if (!makerId || !pointId) {
      expectedSkipped += 1;
      continue;
    }

    const key = `${makerId}::${pointId}`;
    if (seenKeys.has(key)) {
      duplicate += 1;
      continue;
    }

    seenKeys.add(key);
    uniqueRows.push({ makerId, pointId });
  }

  let connected = 0;
  let problematicSkipped = 0;

  if (uniqueRows.length) {
    const values = uniqueRows.flatMap((row) => [row.makerId, row.pointId]);
    const valuesSql = uniqueRows.map((_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::text)`).join(', ');

    const connectedRes = await client.query(
      `WITH source_rows(simon_id, point_id) AS (VALUES ${valuesSql})
       SELECT COUNT(*) AS count
       FROM (
         SELECT DISTINCT p.id, m.id
         FROM source_rows s
         JOIN ${quoteIdent('points')} p ON p.point_id = s.point_id
         JOIN ${quoteIdent('makers-extended')} m ON m.maker_id = s.simon_id
       ) connected_rows`,
      values
    );
    connected = Number(connectedRes.rows[0]?.count || 0);
    problematicSkipped = uniqueRows.length - connected;

    if (!options.dryRun) {
      await client.query(
        `WITH source_rows(simon_id, point_id) AS (VALUES ${valuesSql})
         INSERT INTO ${quoteIdent(POINT_MAKER_LINK_TABLE)} (${quoteIdent('point_id')}, ${quoteIdent('maker_extended_id')}, ${quoteIdent('point_ord')})
         SELECT DISTINCT p.id, m.id, 1
         FROM source_rows s
         JOIN ${quoteIdent('points')} p ON p.point_id = s.point_id
         JOIN ${quoteIdent('makers-extended')} m ON m.maker_id = s.simon_id`,
        values
      );
    }
  }

  if (options.reportMissingTargets && uniqueRows.length) {
    const values = uniqueRows.flatMap((row) => [row.makerId, row.pointId]);
    const valuesSql = uniqueRows.map((_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::text)`).join(', ');
    const res = await client.query(
      `WITH source_rows(simon_id, point_id) AS (VALUES ${valuesSql})
       SELECT s.simon_id, s.point_id
       FROM source_rows s
       WHERE NOT EXISTS (
         SELECT 1
         FROM ${quoteIdent('points')} p
         JOIN ${quoteIdent('makers-extended')} m ON m.maker_id = s.simon_id
         WHERE p.point_id = s.point_id
       )
       ORDER BY s.simon_id, s.point_id
       LIMIT 50`,
      values
    );
    if (res.rows.length) {
      console.log(`[missing-targets] points::makers-extended: ${res.rows.map((row) => `${row.simon_id}/${row.point_id}`).join(', ')}`);
    }
  }

  console.log(`[integrity] ${label}: sourceRows=${csvRows.length}, connected=${connected}, skipped=${expectedSkipped + problematicSkipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), duplicate=${duplicate}, failed=0`);
  logStepEnd(label);

  return { label, sourceRows: csvRows.length, connected, expectedSkipped, problematicSkipped, failed: 0 };
}

async function run() {
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const selectedCollections = getSelectedCollections();
  const selectedTables = new Set(selectedCollections.map((config) => config.table));
  if (options.collections?.size && !selectedCollections.length) {
    throw new Error(`No matching collections for --collections=${[...options.collections].join(',')}`);
  }

  await client.connect();
  try {
    const mode = options.relationsOnly ? 'relations-only' : options.deleteOnly ? 'delete-only' : options.deleteExisting ? 'delete+import' : 'import';
    console.log(`Mode: ${mode}`);
    console.log(`CSV dir: ${options.csvDir}`);
    console.log(`Insert batch size: ${options.insertBatchSize}`);
    if (options.dryRun) console.log('Dry run enabled: no write operations will be sent.');

    if (!options.relationsOnly && (options.deleteExisting || options.deleteOnly)) {
      await truncateHandledTables(client, selectedCollections);
    }

    if (!options.relationsOnly && !options.deleteOnly) {
      for (const config of selectedCollections) {
        await uploadCollection(client, config);
      }
    }

    const shouldProcessTerms = selectedTables.has('terms');
    if (!options.deleteOnly && shouldProcessTerms) {
      await enrichInstrumentTerms(client);
    }

    const shouldProcessInstrumentAssociations =
      selectedTables.has('terms') ||
      selectedTables.has('instruments_known') ||
      selectedTables.has('instruments_advertised');
    if (!options.deleteOnly && shouldProcessInstrumentAssociations) {
      await syncInstrumentMakerTermAssociationsPg(client);
    }

    if (!options.deleteOnly && !options.skipRelations) {
      await clearLinkTables(client);
      const summaries = [];
      for (const link of RELATION_LINKS) {
        summaries.push(await linkRelations(client, link));
      }
      summaries.push(await linkSourcesToMakers(client));
      summaries.push(await linkPointsToMakers(client));

      const totals = summaries.reduce((acc, item) => {
        acc.connected += item.connected;
        acc.expected += item.expectedSkipped;
        acc.problematic += item.problematicSkipped;
        acc.failed += item.failed;
        return acc;
      }, { connected: 0, expected: 0, problematic: 0, failed: 0 });

      console.log(`[integrity] totals: connected=${totals.connected}, skipped=${totals.expected + totals.problematic} (expected=${totals.expected}, problematic=${totals.problematic}), failed=${totals.failed}`);

      if (options.strictRelations && (totals.problematic > 0 || totals.failed > 0)) {
        throw new Error(`[strict-relations] integrity check failed: ${totals.problematic} problematic skipped, ${totals.failed} failed relation links.`);
      }
    }

    console.log('Direct PostgreSQL CSV sync complete.');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
