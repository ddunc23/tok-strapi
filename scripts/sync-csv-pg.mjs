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
  return options.collections
    ? COLLECTIONS.filter((config) => options.collections.has(config.name) || options.collections.has(config.table))
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

async function linkRelations(client, link) {
  const label = `link ${link.label}`;
  logStepStart(label);

  const sourceTable = quoteIdent(link.sourceTable);
  const targetTable = quoteIdent(link.targetTable);
  const linkTable = quoteIdent(link.linkTable);
  const sourceValueColumn = quoteIdent(link.sourceValueColumn);
  const targetValueColumn = quoteIdent(link.targetValueColumn);
  const sourceLinkColumn = quoteIdent(link.sourceLinkColumn);
  const targetLinkColumn = quoteIdent(link.targetLinkColumn);
  const ordColumn = quoteIdent(link.ordColumn);

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
      console.log(`[missing-targets] ${link.targetTable}::${link.targetValueColumn.replace(/"/g, '')}: ${res.rows.map((r) => r.missing_value).join(', ')}`);
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

  console.log(`[integrity] ${link.label}: sourceRows=${sourceRows}, connected=${connected}, skipped=${expectedSkipped + problematicSkipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=0`);
  logStepEnd(label);

  return { label: link.label, sourceRows, connected, expectedSkipped, problematicSkipped, failed: 0 };
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

    if (!options.deleteOnly && !options.skipRelations) {
      await clearLinkTables(client);
      const summaries = [];
      for (const link of RELATION_LINKS) {
        summaries.push(await linkRelations(client, link));
      }
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
