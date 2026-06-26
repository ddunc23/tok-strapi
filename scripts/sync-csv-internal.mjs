import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { createStrapi, compileStrapi } from '@strapi/core';

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
};

const COLLECTIONS = [
  {
    name: 'makersExtended',
    endpoint: 'makers-extended',
    uid: 'api::maker-extended.maker-extended',
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
    uid: 'api::address.address',
    csvFiles: ['address.csv'],
    integerFields: ['address_id', 'maker_id', 'town_location_id'],
    keyFields: ['address_id'],
  },
  {
    name: 'townLocations',
    endpoint: 'town-locations',
    uid: 'api::town-location.town-location',
    csvFiles: ['town-location.csv'],
    integerFields: ['town_location_id'],
    keyFields: ['town_location_id'],
  },
  {
    name: 'guilds',
    endpoint: 'guilds',
    uid: 'api::guild.guild',
    csvFiles: ['guild.csv'],
    integerFields: ['guild_id'],
    keyFields: ['guild_id'],
  },
  {
    name: 'memberships',
    endpoint: 'memberships',
    uid: 'api::membership.membership',
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
    uid: 'api::relation.relation',
    csvFiles: ['relation.csv'],
    integerFields: ['maker_id', 'relation_code', 'relation_id', 'relation_type_id', 'target_maker_id'],
    excludeFields: ['relation_type_meta_id'],
    keyFields: ['relation_id'],
  },
  {
    name: 'instrumentsKnown',
    endpoint: 'instruments-known',
    uid: 'api::instrument-known.instrument-known',
    csvFiles: ['instrument-known.csv', 'instrument_known.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
  },
  {
    name: 'instrumentsAdvertised',
    endpoint: 'instruments-advertised',
    uid: 'api::instrument-advertised.instrument-advertised',
    csvFiles: ['instrument-advertised.csv'],
    integerFields: ['maker_id', 'inst_code', 'id'],
    excludeFields: ['id'],
    keyFields: ['maker_id', 'inst_code', 'inst_name'],
  },
];

const RELATION_LINKS = [
  {
    sourceEndpoint: 'addresses',
    sourceUid: 'api::address.address',
    sourceIdField: 'maker_id',
    targetEndpoint: 'makers-extended',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
  },
  {
    sourceEndpoint: 'addresses',
    sourceUid: 'api::address.address',
    sourceIdField: 'town_location_id',
    targetEndpoint: 'town-locations',
    targetIdField: 'town_location_id',
    connectionField: 'town_location',
  },
  {
    sourceEndpoint: 'memberships',
    sourceUid: 'api::membership.membership',
    sourceIdField: 'maker_id',
    targetEndpoint: 'makers-extended',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
  },
  {
    sourceEndpoint: 'memberships',
    sourceUid: 'api::membership.membership',
    sourceIdField: 'guild_id',
    targetEndpoint: 'guilds',
    targetIdField: 'guild_id',
    connectionField: 'guild',
  },
  {
    sourceEndpoint: 'relations',
    sourceUid: 'api::relation.relation',
    sourceIdField: 'maker_id',
    targetEndpoint: 'makers-extended',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
  },
  {
    sourceEndpoint: 'instruments-known',
    sourceUid: 'api::instrument-known.instrument-known',
    sourceIdField: 'maker_id',
    targetEndpoint: 'makers-extended',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
  },
  {
    sourceEndpoint: 'instruments-advertised',
    sourceUid: 'api::instrument-advertised.instrument-advertised',
    sourceIdField: 'maker_id',
    targetEndpoint: 'makers-extended',
    targetIdField: 'Maker_ID',
    connectionField: 'maker_extended',
  },
];

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

function getDocumentId(record) {
  return record?.documentId || record?.id || null;
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

function addRelationIntegrityEntry(entry) {
  integrityReport.relationLinks.push(entry);
}

function setTargetMakerIntegrityEntry(entry) {
  integrityReport.targetMakerLink = entry;
}

function setTargetMakerBackfillIntegrityEntry(entry) {
  integrityReport.targetMakerBackfill = entry;
}

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

  const logEntry = (entry, sourceLabel = 'sourceRows') => {
    const expectedSkipped = entry.expectedSkipped ?? 0;
    const problematicSkipped = entry.problematicSkipped ?? entry.skipped ?? 0;
    totalConnected += entry.connected;
    totalSkipped += entry.skipped;
    totalExpectedSkipped += expectedSkipped;
    totalProblematicSkipped += problematicSkipped;
    totalFailed += entry.failed;
    console.log(
      `[integrity] ${entry.name}: ${sourceLabel}=${entry.sourceRows}, connected=${entry.connected}, skipped=${entry.skipped} (expected=${expectedSkipped}, problematic=${problematicSkipped}), failed=${entry.failed}`
    );
  };

  for (const entry of integrityReport.relationLinks) {
    logEntry(entry);
  }

  if (integrityReport.targetMakerLink) {
    logEntry(integrityReport.targetMakerLink);
  }

  if (integrityReport.targetMakerBackfill) {
    logEntry(integrityReport.targetMakerBackfill, 'candidates');
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

function makeRecordKey(record, fields) {
  return fields.map((field) => {
    const value = record?.[field];
    return value === null || value === undefined ? '' : String(value);
  }).join('::');
}

function stripInternalFields(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith('__'))
  );
}

function makeMapByField(records, fieldName) {
  const map = new Map();
  for (const record of records) {
    const value = record?.[fieldName];
    const documentId = record?.documentId;
    if (value === null || value === undefined || !documentId) continue;

    const key = String(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(documentId);
  }
  return map;
}

async function fetchAllDocuments(strapi, uid, fields = null) {
  const pageSize = 500;
  let start = 0;
  const all = [];

  while (true) {
    const params = {
      pagination: { start, limit: pageSize },
    };
    if (fields?.length) {
      params.fields = fields;
    }

    const rows = await strapi.documents(uid).findMany(params);
    if (!rows.length) break;

    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }

  return all;
}

async function deleteAllRecords(strapi, config) {
  const rows = await fetchAllDocuments(strapi, config.uid);
  let deleted = 0;

  for (const row of rows) {
    const documentId = getDocumentId(row);
    if (!documentId) continue;
    if (!options.dryRun) {
      await strapi.documents(config.uid).delete({ documentId });
    }
    deleted += 1;
  }

  console.log(`[delete] ${config.endpoint}: removed ${deleted} existing records`);
}

async function uploadCollection(strapi, config) {
  const rows = readCsvRecords(config, options.csvDir);
  const existingRows = await fetchAllDocuments(strapi, config.uid, config.keyFields);

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
      const payload = stripInternalFields(row);

      if (existingDocumentId) {
        if (!options.dryRun) {
          await strapi.documents(config.uid).update({
            documentId: existingDocumentId,
            data: payload,
          });
        }
        updated += 1;
      } else {
        let createdDoc = null;
        if (!options.dryRun) {
          createdDoc = await strapi.documents(config.uid).create({ data: payload });
        }
        const createdDocumentId = createdDoc?.documentId || null;
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

function getConfigByEndpoint(endpoint) {
  const found = COLLECTIONS.find((config) => config.endpoint === endpoint);
  if (!found) throw new Error(`Missing config for endpoint: ${endpoint}`);
  return found;
}

async function connectRelation(strapi, linkConfig) {
  const sourceConfig = getConfigByEndpoint(linkConfig.sourceEndpoint);
  const targetConfig = getConfigByEndpoint(linkConfig.targetEndpoint);

  const sourceRows = await fetchAllDocuments(strapi, sourceConfig.uid, [linkConfig.sourceIdField]);
  const targetRows = await fetchAllDocuments(strapi, targetConfig.uid, [linkConfig.targetIdField]);
  const targetMap = makeMapByField(targetRows, linkConfig.targetIdField);

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingSourceDocumentId = 0;
  let skippedMissingForeignKey = 0;
  let skippedMissingTarget = 0;

  for (let start = 0; start < sourceRows.length; start += options.relationBatchSize) {
    const batch = sourceRows.slice(start, start + options.relationBatchSize);

    for (const sourceRow of batch) {
      const sourceDocumentId = sourceRow?.documentId;
      const sourceForeignKey = sourceRow?.[linkConfig.sourceIdField];

      if (!sourceDocumentId) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: missing source documentId ${sourceRow?.documentId}`
        );
        skipped += 1;
        skippedMissingSourceDocumentId += 1;
        continue;
      }

      if (sourceForeignKey === null || sourceForeignKey === undefined) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: missing foreign key ${linkConfig.sourceIdField}`
        );
        skipped += 1;
        skippedMissingForeignKey += 1;
        continue;
      }

      const targetDocumentIds = targetMap.get(String(sourceForeignKey));
      const targetDocumentId = targetDocumentIds?.[0];

      if (!targetDocumentId) {
        logSkip(
          `[skip] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: no target found for ${linkConfig.sourceIdField}=${JSON.stringify(sourceForeignKey)}`
        );
        trackMissingTarget(linkConfig.targetEndpoint, linkConfig.targetIdField, sourceForeignKey);
        skipped += 1;
        skippedMissingTarget += 1;
        continue;
      }

      try {
        if (!options.dryRun) {
          await strapi.documents(sourceConfig.uid).update({
            documentId: sourceDocumentId,
            data: {
              [linkConfig.connectionField]: {
                connect: [targetDocumentId],
              },
            },
          });
        }
        connected += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint} failed: ${error.message}`
        );
      }
    }

    console.log(
      `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: processed ${Math.min(start + batch.length, sourceRows.length)}/${sourceRows.length} source rows`
    );
  }

  console.log(
    `[connect] ${linkConfig.sourceEndpoint} -> ${linkConfig.targetEndpoint}: ${connected} connected, ${skipped} skipped, ${failed} failed`
  );

  addRelationIntegrityEntry({
    name: `${linkConfig.sourceEndpoint} -> ${linkConfig.sourceEndpoint} (${linkConfig.connectionField})`,
    sourceRows: sourceRows.length,
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

async function connectTargetMakers(strapi) {
  const relationConfig = getConfigByEndpoint('relations');
  const makersConfig = getConfigByEndpoint('makers-extended');

  const relationRows = await fetchAllDocuments(strapi, relationConfig.uid, ['target_maker_id', 'relation_id']);
  const makerRows = await fetchAllDocuments(strapi, makersConfig.uid, ['Maker_ID']);
  const makerMap = makeMapByField(makerRows, 'Maker_ID');

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingTargetMakerId = 0;
  let skippedMissingRelationDocumentId = 0;
  let skippedMissingMakerExtended = 0;

  for (let start = 0; start < relationRows.length; start += options.relationBatchSize) {
    const batch = relationRows.slice(start, start + options.relationBatchSize);

    for (const relationRow of batch) {
      const relationDocumentId = relationRow?.documentId;
      const targetMakerId = relationRow?.target_maker_id;

      if (!relationDocumentId) {
        logSkip('[skip] relations -> makers-extended (target_maker_extended): missing relation documentId');
        skipped += 1;
        skippedMissingRelationDocumentId += 1;
        continue;
      }

      if (targetMakerId === null || targetMakerId === undefined) {
        logSkip('[skip] relations -> makers-extended (target_maker_extended): missing target_maker_id');
        skipped += 1;
        skippedMissingTargetMakerId += 1;
        continue;
      }

      const makerDocumentIds = makerMap.get(String(targetMakerId));
      const makerDocumentId = makerDocumentIds?.[0];
      if (!makerDocumentId) {
        logSkip(
          `[skip] relations -> makers-extended (target_maker_extended): no maker found for target_maker_id=${JSON.stringify(targetMakerId)}`
        );
        trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
        skipped += 1;
        skippedMissingMakerExtended += 1;
        continue;
      }

      try {
        if (!options.dryRun) {
          await strapi.documents(relationConfig.uid).update({
            documentId: relationDocumentId,
            data: {
              target_maker_extended: {
                connect: [makerDocumentId],
              },
            },
          });
        }
        connected += 1;
      } catch (error) {
        failed += 1;
        console.error(`[connect] relations.target_maker_extended failed: ${error.message}`);
      }
    }

    console.log(
      `[connect] relations -> makers-extended (target_maker_extended): processed ${Math.min(start + batch.length, relationRows.length)}/${relationRows.length} source rows`
    );
  }

  console.log(
    `[connect] relations -> makers-extended (target_maker_extended): ${connected} connected, ${skipped} skipped, ${failed} failed`
  );

  setTargetMakerIntegrityEntry({
    name: 'relations -> makers-extended (target_maker_extended)',
    sourceRows: relationRows.length,
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

async function backfillMissingTargetMakersExtended(strapi) {
  const relationConfig = getConfigByEndpoint('relations');
  const makersConfig = getConfigByEndpoint('makers-extended');

  const relationRows = await fetchAllDocuments(strapi, relationConfig.uid, ['target_maker_id', 'target_maker_extended']);
  const makerRows = await fetchAllDocuments(strapi, makersConfig.uid, ['Maker_ID']);
  const makerMap = makeMapByField(makerRows, 'Maker_ID');

  const candidates = relationRows.filter((row) => row?.target_maker_id !== null && row?.target_maker_id !== undefined && !row?.target_maker_extended);

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let skippedMissingRelationDocumentId = 0;
  let skippedMissingMakerExtended = 0;

  for (const relationRow of candidates) {
    const relationDocumentId = relationRow?.documentId;
    const targetMakerId = relationRow?.target_maker_id;

    if (!relationDocumentId) {
      skipped += 1;
      skippedMissingRelationDocumentId += 1;
      continue;
    }

    const makerDocumentIds = makerMap.get(String(targetMakerId));
    const makerDocumentId = makerDocumentIds?.[0];
    if (!makerDocumentId) {
      skipped += 1;
      skippedMissingMakerExtended += 1;
      trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
      continue;
    }

    try {
      if (!options.dryRun) {
        await strapi.documents(relationConfig.uid).update({
          documentId: relationDocumentId,
          data: {
            target_maker_extended: {
              connect: [makerDocumentId],
            },
          },
        });
      }
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

async function clearAllRelations(strapi) {
  const relationFieldsToClear = {};

  for (const linkConfig of RELATION_LINKS) {
    if (!relationFieldsToClear[linkConfig.sourceEndpoint]) {
      relationFieldsToClear[linkConfig.sourceEndpoint] = new Set();
    }
    relationFieldsToClear[linkConfig.sourceEndpoint].add(linkConfig.connectionField);
  }

  relationFieldsToClear.relations.add('target_maker_extended');

  for (const [endpoint, fieldSet] of Object.entries(relationFieldsToClear)) {
    const config = getConfigByEndpoint(endpoint);
    const rows = await fetchAllDocuments(strapi, config.uid);
    const fields = [...fieldSet];
    let cleared = 0;
    let failed = 0;

    for (const row of rows) {
      const documentId = getDocumentId(row);
      if (!documentId) continue;

      const data = Object.fromEntries(fields.map((field) => [field, null]));

      try {
        if (!options.dryRun) {
          await strapi.documents(config.uid).update({
            documentId,
            data,
          });
        }
        cleared += 1;
      } catch (error) {
        failed += 1;
        console.error(`[clear] ${endpoint} failed for ${documentId}: ${error.message}`);
      }
    }

    console.log(`[clear] ${endpoint}: cleared ${fields.join(', ')} for ${cleared} records (${failed} failed)`);
  }
}

async function runWithStrapi() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();

  try {
    const mode = options.relationsOnly
      ? 'relations-only'
      : options.deleteOnly
        ? 'delete-only'
        : options.deleteExisting
          ? 'delete+import'
          : 'import';

    console.log(`CSV dir: ${options.csvDir}`);
    console.log(`Mode: ${mode}`);
    if (options.skipRelations) {
      console.log('Relation linking: skipped');
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
    if (options.collections?.size) {
      console.log(`Collections filter: ${[...options.collections].join(', ')}`);
    }
    console.log(`Relation batch size: ${options.relationBatchSize}`);
    if (options.dryRun) {
      console.log('Dry run enabled: no write operations will be sent.');
    }

    const selectedCollections = options.collections
      ? COLLECTIONS.filter(
          (config) => options.collections.has(config.name) || options.collections.has(config.endpoint)
        )
      : COLLECTIONS;

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
        await deleteAllRecords(app, config);
      }
    }

    if (!options.relationsOnly && !options.deleteOnly) {
      for (const config of selectedCollections) {
        await uploadCollection(app, config);
      }
    }

    if (!options.deleteOnly && !options.skipRelations) {
      if (options.clearRelationsOnly) {
        await clearAllRelations(app);
      }

      for (const linkConfig of RELATION_LINKS) {
        await connectRelation(app, linkConfig);
      }

      await connectTargetMakers(app);
      await backfillMissingTargetMakersExtended(app);

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

    console.log('Internal CSV sync complete.');
  } finally {
    await app.destroy();
  }
}

runWithStrapi().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
