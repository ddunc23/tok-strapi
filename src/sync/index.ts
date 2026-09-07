import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { Core } from '@strapi/strapi';

// ---------------------------------------------------------------------------
// Options – read from environment variables so the script can be driven
// entirely from the command line without touching code.
//
//   SYNC_CSV=true                      run sync on bootstrap then exit
//   SYNC_CSV_DELETE=true               delete all records first
//   SYNC_CSV_DELETE_ONLY=true          delete only, no import
//   SYNC_CSV_RELATIONS_ONLY=true       skip collection import, run linking only
//   SYNC_CSV_SKIP_RELATIONS=true       skip relation linking
//   SYNC_CSV_CLEAR_RELATIONS=true      disconnect all relation fields before linking
//   SYNC_CSV_STRICT=true               exit non-zero if problematic skips > 0
//   SYNC_CSV_REPORT_MISSING=true       print top-50 missing FK values per field
//   SYNC_CSV_VERBOSE_SKIPS=true        print individual skip messages
//   SYNC_CSV_DRY_RUN=true              no writes
//   SYNC_CSV_DIR=/path                 override CSV directory
//   SYNC_CSV_COLLECTIONS=a,b           filter to specific collections
//   SYNC_CSV_BATCH_SIZE=500            relation linking batch size
// ---------------------------------------------------------------------------

function env(key: string): string | undefined {
  return process.env[key];
}

function envBool(key: string): boolean {
  return env(key) === 'true' || env(key) === '1';
}

function envInt(key: string, fallback: number): number {
  const value = env(key);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const options = {
  deleteExisting: envBool('SYNC_CSV_DELETE'),
  deleteOnly: envBool('SYNC_CSV_DELETE_ONLY'),
  dryRun: envBool('SYNC_CSV_DRY_RUN'),
  relationsOnly: envBool('SYNC_CSV_RELATIONS_ONLY'),
  skipRelations: envBool('SYNC_CSV_SKIP_RELATIONS'),
  strictRelations: envBool('SYNC_CSV_STRICT'),
  verboseSkips: envBool('SYNC_CSV_VERBOSE_SKIPS'),
  reportMissingTargets: envBool('SYNC_CSV_REPORT_MISSING'),
  clearRelationsOnly: envBool('SYNC_CSV_CLEAR_RELATIONS'),
  csvDir: env('SYNC_CSV_DIR') || path.join(process.cwd(), 'data', 'csv'),
  collections: (() => {
    const value = env('SYNC_CSV_COLLECTIONS');
    if (!value) return null;
    const items = value.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length ? new Set(items) : null;
  })(),
  pageSize: envInt('SYNC_CSV_PAGE_SIZE', 50),
  batchSize: envInt('SYNC_CSV_BATCH_SIZE', 50),
};

// ---------------------------------------------------------------------------
// Collection configs
// ---------------------------------------------------------------------------

function coerceMakerId(value: any): any {
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

type CollectionConfig = {
  name: string;
  endpoint: string;
  uid: `api::${string}.${string}`;
  csvFiles: string[];
  integerFields?: string[];
  dateFields?: string[];
  fieldAliases?: Record<string, string[]>;
  fieldTransforms?: Record<string, (v: any, r: any) => any>;
  excludeFields?: string[];
  keyFields: string[];
};

type RelationLinkConfig = {
  sourceEndpoint: string;
  sourceUid: `api::${string}.${string}`;
  sourceIdField: string;
  targetEndpoint: string;
  targetIdField: string;
  connectionField: string;
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

const COLLECTIONS: CollectionConfig[] = [
  {
    name: 'makersExtended',
    endpoint: 'makers-extended',
    uid: 'api::maker-extended.maker-extended',
    csvFiles: ['makers-extended-with-events.csv', 'maker-extended.csv', 'maker-extended-extract.csv'],
    integerFields: ['Maker_ID'],
    dateFields: [
      'Birth_Date', 'Establishment_Date', 'Working_Start_Date', 'Working_End_Date',
      'Flourishing_Start_Date', 'Flourishing_End_Date', 'Retirement_Date', 'Death_Date',
      'Date_1', 'Date_2',
    ],
    fieldAliases: { Maker_ID: ['ID'] },
    fieldTransforms: { Maker_ID: coerceMakerId },
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
    excludeFields: ['entry', 'entry_date_1', 'entry_date_2', 'uncertain', 'misc_codes', 'entry_date_1_certainty', 'entry_date_2_certainty'],
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
  {
    name: 'instrumentTerms',
    endpoint: 'terms',
    uid: 'api::term.term',
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

const RELATION_LINKS: RelationLinkConfig[] = [
  { sourceEndpoint: 'addresses', sourceUid: 'api::address.address', sourceIdField: 'maker_id', targetEndpoint: 'makers-extended', targetIdField: 'Maker_ID', connectionField: 'maker_extended' },
  { sourceEndpoint: 'addresses', sourceUid: 'api::address.address', sourceIdField: 'town_location_id', targetEndpoint: 'town-locations', targetIdField: 'town_location_id', connectionField: 'town_location' },
  { sourceEndpoint: 'memberships', sourceUid: 'api::membership.membership', sourceIdField: 'maker_id', targetEndpoint: 'makers-extended', targetIdField: 'Maker_ID', connectionField: 'maker_extended' },
  { sourceEndpoint: 'memberships', sourceUid: 'api::membership.membership', sourceIdField: 'guild_id', targetEndpoint: 'guilds', targetIdField: 'guild_id', connectionField: 'guild' },
  { sourceEndpoint: 'relations', sourceUid: 'api::relation.relation', sourceIdField: 'maker_id', targetEndpoint: 'makers-extended', targetIdField: 'Maker_ID', connectionField: 'maker_extended' },
  { sourceEndpoint: 'instruments-known', sourceUid: 'api::instrument-known.instrument-known', sourceIdField: 'maker_id', targetEndpoint: 'makers-extended', targetIdField: 'Maker_ID', connectionField: 'maker_extended' },
  { sourceEndpoint: 'instruments-advertised', sourceUid: 'api::instrument-advertised.instrument-advertised', sourceIdField: 'maker_id', targetEndpoint: 'makers-extended', targetIdField: 'Maker_ID', connectionField: 'maker_extended' },
];

// ---------------------------------------------------------------------------
// Record normalisation helpers
// ---------------------------------------------------------------------------

function rowValueToNullable(value: any): any {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function castIntegerFields(record: Record<string, any>, fields: string[] = []): Record<string, any> {
  const next = { ...record };
  for (const field of fields) {
    if (!(field in next) || next[field] === null) { next[field] = next[field] ?? null; continue; }
    const num = Number.parseInt(String(next[field]), 10);
    next[field] = Number.isNaN(num) ? null : num;
  }
  return next;
}

function castDateFields(record: Record<string, any>, fields: string[] = []): Record<string, any> {
  const next = { ...record };
  for (const field of fields) {
    if (!(field in next) || next[field] === null) { next[field] = next[field] ?? null; continue; }
    const str = String(next[field]).trim();
    if (!str) { next[field] = null; continue; }
    if (/^\d{4}$/.test(str)) { next[field] = `${str}-01-01`; continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) { continue; }
    next[field] = null;
  }
  return next;
}

function removeExcludedFields(record: Record<string, any>, fields: string[] = []): Record<string, any> {
  const next = { ...record };
  for (const field of fields) delete next[field];
  return next;
}

function applyFieldAliases(record: Record<string, any>, aliases: Record<string, string[]> = {}): Record<string, any> {
  const next = { ...record };
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (next[canonical] !== null && next[canonical] !== undefined && next[canonical] !== '') continue;
    for (const alias of aliasList) {
      if (next[alias] !== null && next[alias] !== undefined && next[alias] !== '') {
        next[canonical] = next[alias];
        break;
      }
    }
  }
  return next;
}

function applyFieldTransforms(record: Record<string, any>, transforms: Record<string, Function> = {}): Record<string, any> {
  const next = { ...record };
  for (const [field, fn] of Object.entries(transforms)) {
    if (field in next && typeof fn === 'function') next[field] = fn(next[field], next);
  }
  return next;
}

function normalizeRecord(row: Record<string, any>, config: CollectionConfig): Record<string, any> {
  let r = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rowValueToNullable(v)]));
  r = applyFieldAliases(r, config.fieldAliases);
  r = applyFieldTransforms(r, config.fieldTransforms);
  r = castIntegerFields(r, config.integerFields);
  r = castDateFields(r, config.dateFields);
  r = removeExcludedFields(r, config.excludeFields);
  return r;
}

function readCsvRecords(config: CollectionConfig): Array<Record<string, any>> {
  for (const fileName of config.csvFiles) {
    const csvPath = path.join(options.csvDir, fileName);
    if (!fs.existsSync(csvPath)) continue;

    const content = fs.readFileSync(csvPath, 'utf8');
    const rows = parse(content, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
    return rows.map((row: any, i: number) => ({
      ...normalizeRecord(row, config),
      __csvFile: fileName,
      __csvRowNumber: i + 2,
    }));
  }
  throw new Error(`CSV not found for ${config.name}. Looked for: ${config.csvFiles.join(', ')}`);
}

function makeRecordKey(record: Record<string, any>, fields: string[]): string {
  return fields.map((f) => (record[f] == null ? '' : String(record[f]))).join('::');
}

function stripInternalFields(record: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('__')));
}

function makeMapByField(records: any[], fieldName: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const record of records) {
    const value = record?.[fieldName];
    const documentId = record?.documentId;
    if (value == null || !documentId) continue;
    const key = String(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(documentId);
  }
  return map;
}

function logSkip(message: string) {
  if (options.verboseSkips) console.warn(message);
}

function logStepStart(label: string) {
  console.log(`[step] ${label}: start`);
}

function logStepEnd(label: string) {
  console.log(`[step] ${label}: done`);
}

function logProgress(label: string, processed: number, note?: string) {
  const suffix = note ? ` ${note}` : '';
  console.log(`[progress] ${label}: ${processed}${suffix}`);
}

// ---------------------------------------------------------------------------
// Integrity / missing-target reporting
// ---------------------------------------------------------------------------

type IntegrityEntry = {
  name: string;
  sourceRows: number;
  connected: number;
  skipped: number;
  expectedSkipped: number;
  problematicSkipped: number;
  failed: number;
  skipBreakdown?: Record<string, number>;
};

const integrityReport: { relationLinks: IntegrityEntry[]; targetMakerLink: IntegrityEntry | null; targetMakerBackfill: IntegrityEntry | null } = {
  relationLinks: [],
  targetMakerLink: null,
  targetMakerBackfill: null,
};

const missingTargetsMap: Record<string, Map<any, number>> = {};

function trackMissingTarget(endpoint: string, field: string, value: any) {
  if (!options.reportMissingTargets) return;
  const key = `${endpoint}::${field}`;
  if (!missingTargetsMap[key]) missingTargetsMap[key] = new Map();
  const m = missingTargetsMap[key];
  m.set(value, (m.get(value) || 0) + 1);
}

function printMissingTargetsReport() {
  const entries = Object.entries(missingTargetsMap);
  if (!entries.length) { console.log('[missing-targets] no missing targets reported.'); return; }
  console.log('[missing-targets] report:');
  for (const [key, counts] of entries) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    console.log(`[missing-targets] ${key}: ${counts.size} unique missing, top 50: [${sorted.map(([id]) => id).join(', ')}]`);
  }
}

function printIntegrityReport(): { totalProblematicSkipped: number; totalFailed: number; hasIssues: boolean } {
  let totalConnected = 0, totalSkipped = 0, totalExpected = 0, totalProblematic = 0, totalFailed = 0;

  const allEntries: Array<{ entry: IntegrityEntry; label: string }> = [
    ...integrityReport.relationLinks.map((e) => ({ entry: e, label: 'sourceRows' })),
    ...(integrityReport.targetMakerLink ? [{ entry: integrityReport.targetMakerLink, label: 'sourceRows' }] : []),
    ...(integrityReport.targetMakerBackfill ? [{ entry: integrityReport.targetMakerBackfill, label: 'candidates' }] : []),
  ];

  if (!allEntries.length) {
    console.log('[integrity] no relation linking steps executed.');
    return { totalProblematicSkipped: 0, totalFailed: 0, hasIssues: false };
  }

  console.log('[integrity] relation linking report:');
  for (const { entry: e, label } of allEntries) {
    totalConnected += e.connected;
    totalSkipped += e.skipped;
    totalExpected += e.expectedSkipped;
    totalProblematic += e.problematicSkipped;
    totalFailed += e.failed;
    console.log(`[integrity] ${e.name}: ${label}=${e.sourceRows}, connected=${e.connected}, skipped=${e.skipped} (expected=${e.expectedSkipped}, problematic=${e.problematicSkipped}), failed=${e.failed}`);
  }

  console.log(`[integrity] totals: connected=${totalConnected}, skipped=${totalSkipped} (expected=${totalExpected}, problematic=${totalProblematic}), failed=${totalFailed}`);
  return { totalProblematicSkipped: totalProblematic, totalFailed, hasIssues: totalProblematic > 0 || totalFailed > 0 };
}

// ---------------------------------------------------------------------------
// Document Service helpers
// ---------------------------------------------------------------------------

async function fetchAllDocuments(strapi: Core.Strapi, uid: any, fields?: string[]): Promise<any[]> {
  const pageSize = options.pageSize;
  let start = 0;
  const all: any[] = [];

  while (true) {
    const params: any = { pagination: { start, limit: pageSize } };
    if (fields?.length) params.fields = fields;
    const rows = await (strapi.documents as any)(uid).findMany(params);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }

  return all;
}

async function forEachDocumentPage(
  strapi: Core.Strapi,
  uid: any,
  fields: string[] | undefined,
  progressLabel: string | undefined,
  onPage: (rows: any[]) => Promise<void> | void,
) {
  const pageSize = options.pageSize;
  let start = 0;
  let processed = 0;
  let page = 0;

  while (true) {
    const params: any = { pagination: { start, limit: pageSize } };
    if (fields?.length) params.fields = fields;

    const rows = await (strapi.documents as any)(uid).findMany(params);
    if (!rows.length) break;

    await onPage(rows);
    processed += rows.length;
    page += 1;
    if (progressLabel) {
      logProgress(progressLabel, processed, `(pages=${page})`);
    }

    if (rows.length < pageSize) break;
    start += pageSize;
  }
}

function addRowsToFieldMap(map: Map<string, string[]>, rows: any[], fieldName: string) {
  for (const record of rows) {
    const value = record?.[fieldName];
    const documentId = record?.documentId;
    if (value === null || value === undefined || !documentId) continue;

    const key = String(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(documentId);
  }
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function deleteAllRecords(strapi: Core.Strapi, config: CollectionConfig) {
  const label = `delete ${config.endpoint}`;
  logStepStart(label);
  let deleted = 0;

  while (true) {
    const rows = await (strapi.documents as any)(config.uid).findMany({
      pagination: { start: 0, limit: options.pageSize },
    });

    if (!rows.length) break;

    for (const row of rows) {
      if (!row?.documentId) continue;
      if (!options.dryRun) await (strapi.documents as any)(config.uid).delete({ documentId: row.documentId });
      deleted += 1;
    }

    if (rows.length < options.pageSize) break;
  }

  console.log(`[delete] ${config.endpoint}: removed ${deleted} existing records`);
  logStepEnd(label);
}

async function uploadCollection(strapi: Core.Strapi, config: CollectionConfig) {
  const label = `upload ${config.endpoint}`;
  logStepStart(label);
  const rows = readCsvRecords(config);

  const existingKeyToDocumentId = new Map<string, string>();
  await forEachDocumentPage(strapi, config.uid, config.keyFields, `scan existing ${config.endpoint}`, async (pageRows) => {
    for (const r of pageRows) {
      const key = makeRecordKey(r, config.keyFields);
      if (key && r?.documentId && !existingKeyToDocumentId.has(key)) {
        existingKeyToDocumentId.set(key, r.documentId);
      }
    }
  });

  const processedKeys = new Set<string>();
  let created = 0, updated = 0, skipped = 0, skippedDup = 0, failed = 0;
  let processedRows = 0;

  for (const row of rows) {
    try {
      const key = makeRecordKey(row, config.keyFields);
      if (!key) { skipped += 1; continue; }
      if (processedKeys.has(key)) { skippedDup += 1; continue; }
      processedKeys.add(key);

      const payload = stripInternalFields(row);
      const existingId = existingKeyToDocumentId.get(key);

      if (existingId) {
        if (!options.dryRun) await (strapi.documents as any)(config.uid).update({ documentId: existingId, data: payload });
        updated += 1;
      } else {
        let doc: any = null;
        if (!options.dryRun) doc = await (strapi.documents as any)(config.uid).create({ data: payload });
        if (doc?.documentId) existingKeyToDocumentId.set(key, doc.documentId);
        created += 1;
      }
    } catch (error: any) {
      failed += 1;
      console.error(`[upload] ${config.endpoint} failed: ${error.message}`);
    } finally {
      processedRows += 1;
      if (processedRows % options.batchSize === 0 || processedRows === rows.length) {
        logProgress(label, processedRows, `of ${rows.length}`);
      }
    }
  }

  console.log(`[upload] ${config.endpoint}: ${created} created, ${updated} updated, ${skipped} skipped, ${skippedDup} skippedDuplicate, ${failed} failed`);
  logStepEnd(label);
}

function normalizeTermId(value: any): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeCsvText(value: any): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function getRelationDocumentId(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return null;
  return value.documentId ?? null;
}

async function ensureInstrumentsVocabulary(strapi: Core.Strapi): Promise<string | null> {
  const vocabUid = 'api::vocabulary.vocabulary';
  const existing = await fetchAllDocuments(strapi, vocabUid, ['documentId', 'name', 'slug']);
  const matched = existing.find((v) => v?.slug === 'instruments' || String(v?.name || '').trim().toLowerCase() === 'instruments');

  if (matched?.documentId) return matched.documentId;
  if (options.dryRun) {
    console.log('[terms] dry-run: vocabulary "instruments" does not exist and will not be created.');
    return null;
  }

  const created = await (strapi.documents as any)(vocabUid).create({
    data: {
      name: 'Instruments',
      slug: 'instruments',
    },
  });

  return created?.documentId ?? null;
}

async function enrichInstrumentTerms(strapi: Core.Strapi) {
  const termsConfig = COLLECTIONS.find((c) => c.endpoint === 'terms');
  if (!termsConfig) return;

  const label = 'enrich terms (instruments vocabulary)';
  logStepStart(label);
  const vocabularyDocumentId = await ensureInstrumentsVocabulary(strapi);
  if (!vocabularyDocumentId) {
    logStepEnd(label);
    return;
  }

  const csvRows = readCsvRecords(termsConfig);
  const csvByTermId = new Map<string, Record<string, any>>();
  for (const row of csvRows) {
    const termId = normalizeTermId(row.term_id);
    if (!termId || csvByTermId.has(termId)) continue;
    csvByTermId.set(termId, row);
  }

  const termDocuments = await fetchAllDocuments(strapi, termsConfig.uid, ['documentId', 'term_id']);
  const termDocumentIdByTermId = new Map<string, string>();
  for (const doc of termDocuments) {
    const termId = normalizeTermId(doc?.term_id);
    const documentId = doc?.documentId;
    if (!termId || !documentId || termDocumentIdByTermId.has(termId)) continue;
    termDocumentIdByTermId.set(termId, documentId);
  }

  let updated = 0;
  let missingDocument = 0;
  let missingParent = 0;
  let processed = 0;

  for (const [termId, row] of csvByTermId.entries()) {
    const termDocumentId = termDocumentIdByTermId.get(termId);
    if (!termDocumentId) {
      missingDocument += 1;
      continue;
    }

    const broaderCandidates = INSTRUMENT_TERM_BROADER_ID_FIELDS
      .map((field) => normalizeTermId(row[field]))
      .filter((value): value is string => !!value);
    const parentDocumentId = broaderCandidates
      .map((candidate) => termDocumentIdByTermId.get(candidate))
      .find((candidate): candidate is string => !!candidate);
    if (broaderCandidates.length > 0 && !parentDocumentId) missingParent += 1;

    const relatedDocumentIds = [...new Set(
      INSTRUMENT_TERM_RELATED_ID_FIELDS
        .map((field) => normalizeTermId(row[field]))
        .filter((value): value is string => !!value)
        .map((value) => termDocumentIdByTermId.get(value))
        .filter((value): value is string => !!value)
        .filter((value) => value !== termDocumentId)
    )];

    const data: Record<string, any> = {
      vocabulary: { connect: [vocabularyDocumentId] },
      related_terms: { set: relatedDocumentIds },
    };

    if (parentDocumentId) {
      data.parent = { connect: [parentDocumentId] };
    } else if (broaderCandidates.length === 0) {
      data.parent = null;
    }

    if (!options.dryRun) {
      await (strapi.documents as any)(termsConfig.uid).update({
        documentId: termDocumentId,
        data,
      });
    }

    updated += 1;
    processed += 1;
    if (processed % options.batchSize === 0 || processed === csvByTermId.size) {
      logProgress(label, processed, `of ${csvByTermId.size}`);
    }
  }

  console.log(`[terms] instruments enrich: ${updated} updated, ${missingDocument} missing term documents, ${missingParent} missing parent links`);
  logStepEnd(label);
}

async function syncInstrumentMakerTermAssociations(strapi: Core.Strapi) {
  const knownConfig = COLLECTIONS.find((c) => c.endpoint === 'instruments-known');
  const advertisedConfig = COLLECTIONS.find((c) => c.endpoint === 'instruments-advertised');
  if (!knownConfig || !advertisedConfig) return;

  const label = 'sync maker-term-associations (known/advertised instruments)';
  logStepStart(label);

  const makerConfig = getConfigByEndpoint('makers-extended');
  const termsConfig = getConfigByEndpoint('terms');
  const associationUid = 'api::maker-term-association.maker-term-association';

  const makerRows = await fetchAllDocuments(strapi, makerConfig.uid, ['documentId', 'Maker_ID']);
  const termRows = await fetchAllDocuments(strapi, termsConfig.uid, ['documentId', 'term_id']);

  const makerDocumentIdByMakerId = new Map<string, string>();
  for (const maker of makerRows) {
    const makerId = normalizeTermId(maker?.Maker_ID);
    const documentId = maker?.documentId;
    if (!makerId || !documentId || makerDocumentIdByMakerId.has(makerId)) continue;
    makerDocumentIdByMakerId.set(makerId, documentId);
  }

  const termDocumentIdByTermId = new Map<string, string>();
  for (const term of termRows) {
    const termId = normalizeTermId(term?.term_id);
    const documentId = term?.documentId;
    if (!termId || !documentId || termDocumentIdByTermId.has(termId)) continue;
    termDocumentIdByTermId.set(termId, documentId);
  }

  const desiredByKey = new Map<string, { makerDocumentId: string; termDocumentId: string; associationType: 'KNOWN' | 'ADVERTISED'; evidenceLabel: string | null }>();
  const missingStats = {
    missingMakerId: 0,
    missingTermId: 0,
    makerNotFound: 0,
    termNotFound: 0,
  };

  const collectDesired = (rows: Array<Record<string, any>>, associationType: 'KNOWN' | 'ADVERTISED') => {
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

  collectDesired(readCsvRecords(knownConfig), 'KNOWN');
  collectDesired(readCsvRecords(advertisedConfig), 'ADVERTISED');

  const existingAssociations = await fetchAllDocuments(strapi, associationUid);
  const existingByKey = new Map<string, { documentId: string; evidenceLabel: string | null }>();
  for (const row of existingAssociations) {
    const documentId = row?.documentId;
    const makerDocumentId = getRelationDocumentId(row?.maker_extended);
    const termDocumentId = getRelationDocumentId(row?.term);
    const associationType = normalizeCsvText(row?.association_type);
    if (!documentId || !makerDocumentId || !termDocumentId || !associationType) continue;

    const key = `${makerDocumentId}::${termDocumentId}::${associationType}`;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, {
        documentId,
        evidenceLabel: normalizeCsvText(row?.evidence_label),
      });
    }
  }

  let created = 0;
  let updated = 0;
  let processed = 0;

  for (const [key, desired] of desiredByKey.entries()) {
    const existing = existingByKey.get(key);
    const data = {
      maker_extended: { connect: [desired.makerDocumentId] },
      term: { connect: [desired.termDocumentId] },
      association_type: desired.associationType,
      evidence_label: desired.evidenceLabel,
    };

    if (existing) {
      if (existing.evidenceLabel !== desired.evidenceLabel && !options.dryRun) {
        await (strapi.documents as any)(associationUid).update({
          documentId: existing.documentId,
          data: { evidence_label: desired.evidenceLabel },
        });
        updated += 1;
      }
    } else {
      if (!options.dryRun) {
        await (strapi.documents as any)(associationUid).create({ data });
      }
      created += 1;
    }

    processed += 1;
    if (processed % options.batchSize === 0 || processed === desiredByKey.size) {
      logProgress(label, processed, `of ${desiredByKey.size}`);
    }
  }

  console.log(
    `[associations] maker-term-associations: ${created} created, ${updated} updated, skipped missing maker_id=${missingStats.missingMakerId}, missing inst_code=${missingStats.missingTermId}, maker not found=${missingStats.makerNotFound}, term not found=${missingStats.termNotFound}`
  );

  logStepEnd(label);
}

function getConfigByEndpoint(endpoint: string): CollectionConfig {
  const config = COLLECTIONS.find((c) => c.endpoint === endpoint);
  if (!config) throw new Error(`No config for endpoint: ${endpoint}`);
  return config;
}

async function connectRelation(strapi: Core.Strapi, link: RelationLinkConfig) {
  const label = `connect ${link.sourceEndpoint} -> ${link.targetEndpoint} (${link.connectionField})`;
  logStepStart(label);
  const sourceConfig = getConfigByEndpoint(link.sourceEndpoint);
  const targetConfig = getConfigByEndpoint(link.targetEndpoint);

  const targetMap = new Map<string, string[]>();
  await forEachDocumentPage(strapi, targetConfig.uid, [link.targetIdField], `load targets ${link.targetEndpoint}.${link.targetIdField}`, async (pageRows) => {
    addRowsToFieldMap(targetMap, pageRows, link.targetIdField);
  });

  let connected = 0, skipped = 0, failed = 0;
  let skippedMissingDocId = 0, skippedMissingFK = 0, skippedMissingTarget = 0;
  let sourceRowsCount = 0;

  await forEachDocumentPage(strapi, sourceConfig.uid, [link.sourceIdField], label, async (pageRows) => {
    sourceRowsCount += pageRows.length;

    for (const row of pageRows) {
      const docId = row?.documentId;
      const fk = row?.[link.sourceIdField];

      if (!docId) { logSkip(`[skip] ${link.sourceEndpoint} -> ${link.targetEndpoint}: missing documentId`); skipped += 1; skippedMissingDocId += 1; continue; }
      if (fk == null) { logSkip(`[skip] ${link.sourceEndpoint} -> ${link.targetEndpoint}: missing ${link.sourceIdField}`); skipped += 1; skippedMissingFK += 1; continue; }

      const targetIds = targetMap.get(String(fk));
      if (!targetIds?.length) {
        logSkip(`[skip] ${link.sourceEndpoint} -> ${link.targetEndpoint}: no target for ${link.sourceIdField}=${fk}`);
        trackMissingTarget(link.targetEndpoint, link.targetIdField, fk);
        skipped += 1; skippedMissingTarget += 1; continue;
      }

      for (const targetDocId of targetIds) {
        try {
          if (!options.dryRun) {
            await (strapi.documents as any)(sourceConfig.uid).update({
              documentId: docId,
              data: { [link.connectionField]: { connect: [targetDocId] } },
            });
          }
          connected += 1;
        } catch (error: any) {
          failed += 1;
          console.error(`[connect] ${link.sourceEndpoint} -> ${link.targetEndpoint} failed: ${error.message}`);
        }
      }
    }
  });

  console.log(`[connect] ${link.sourceEndpoint} -> ${link.targetEndpoint} (${link.connectionField}): ${connected} connected, ${skipped} skipped, ${failed} failed`);

  integrityReport.relationLinks.push({
    name: `${link.sourceEndpoint} -> ${link.sourceEndpoint} (${link.connectionField})`,
    sourceRows: sourceRowsCount,
    connected, skipped,
    expectedSkipped: skippedMissingFK,
    problematicSkipped: skippedMissingDocId + skippedMissingTarget,
    failed,
    skipBreakdown: { missingDocumentId: skippedMissingDocId, missingForeignKey: skippedMissingFK, missingTarget: skippedMissingTarget },
  });

  logStepEnd(label);
}

async function connectTargetMakers(strapi: Core.Strapi) {
  const label = 'connect relations -> makers-extended (target_maker_extended)';
  logStepStart(label);
  const relConfig = getConfigByEndpoint('relations');
  const makerConfig = getConfigByEndpoint('makers-extended');

  const makerMap = new Map<string, string[]>();
  await forEachDocumentPage(strapi, makerConfig.uid, ['Maker_ID'], 'load targets makers-extended.Maker_ID', async (pageRows) => {
    addRowsToFieldMap(makerMap, pageRows, 'Maker_ID');
  });

  let connected = 0, skipped = 0, failed = 0;
  let skippedMissingRelDocId = 0, skippedMissingTargetId = 0, skippedMissingMaker = 0;
  let relRowsCount = 0;

  await forEachDocumentPage(strapi, relConfig.uid, ['target_maker_id', 'relation_id'], label, async (pageRows) => {
    relRowsCount += pageRows.length;

    for (const row of pageRows) {
      const relDocId = row?.documentId;
      const targetMakerId = row?.target_maker_id;

      if (!relDocId) {
        logSkip('[skip] target_maker_extended: missing relation documentId');
        skipped += 1;
        skippedMissingRelDocId += 1;
        continue;
      }

      if (targetMakerId == null) {
        logSkip('[skip] target_maker_extended: missing target_maker_id');
        skipped += 1;
        skippedMissingTargetId += 1;
        continue;
      }

      const makerDocIds = makerMap.get(String(targetMakerId));
      if (!makerDocIds?.[0]) {
        logSkip(`[skip] target_maker_extended: no maker for target_maker_id=${targetMakerId}`);
        trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
        skipped += 1;
        skippedMissingMaker += 1;
        continue;
      }

      try {
        if (!options.dryRun) {
          await (strapi.documents as any)(relConfig.uid).update({
            documentId: relDocId,
            data: { target_maker_extended: { connect: [makerDocIds[0]] } },
          });
        }
        connected += 1;
      } catch (error: any) {
        console.error(`[connect] relations.target_maker_extended failed: ${error.message}`);
      }
    }
  });

  console.log(`[connect] relations -> makers-extended (target_maker_extended): ${connected} connected, ${skipped} skipped, ${failed} failed`);

  integrityReport.targetMakerLink = {
    name: 'relations -> makers-extended (target_maker_extended)',
    sourceRows: relRowsCount,
    connected,
    skipped,
    expectedSkipped: skippedMissingTargetId,
    problematicSkipped: skippedMissingRelDocId + skippedMissingMaker,
    failed,
    skipBreakdown: {
      missingRelationDocumentId: skippedMissingRelDocId,
      missingTargetMakerId: skippedMissingTargetId,
      missingMakerExtended: skippedMissingMaker,
    },
  };

  logStepEnd(label);
}

async function backfillMissingTargetMakers(strapi: Core.Strapi) {
  const label = 'backfill relations.target_maker_extended';
  logStepStart(label);
  const relConfig = getConfigByEndpoint('relations');
  const makerConfig = getConfigByEndpoint('makers-extended');

  const makerMap = new Map<string, string[]>();
  await forEachDocumentPage(strapi, makerConfig.uid, ['Maker_ID'], 'load targets makers-extended.Maker_ID', async (pageRows) => {
    addRowsToFieldMap(makerMap, pageRows, 'Maker_ID');
  });

  let connected = 0, skipped = 0, failed = 0;
  let skippedMissingDocId = 0, skippedMissingMaker = 0;
  let candidatesCount = 0;

  await forEachDocumentPage(strapi, relConfig.uid, ['target_maker_id', 'target_maker_extended'], label, async (pageRows) => {
    for (const row of pageRows) {
      const relDocId = row?.documentId;
      const targetMakerId = row?.target_maker_id;
      const linked = row?.target_maker_extended;
      if (targetMakerId == null || linked) continue;
      candidatesCount += 1;

      if (!relDocId) { skipped += 1; skippedMissingDocId += 1; continue; }

      const makerDocIds = makerMap.get(String(targetMakerId));
      if (!makerDocIds?.[0]) {
        trackMissingTarget('makers-extended', 'Maker_ID', targetMakerId);
        skipped += 1; skippedMissingMaker += 1; continue;
      }

      try {
        if (!options.dryRun) {
          await (strapi.documents as any)(relConfig.uid).update({
            documentId: relDocId,
            data: { target_maker_extended: { connect: [makerDocIds[0]] } },
          });
        }
        connected += 1;
      } catch (error: any) {
        failed += 1;
        console.error(`[backfill] relations.target_maker_extended failed: ${error.message}`);
      }
    }
  });

  console.log(`[backfill] relations.target_maker_extended: ${connected} connected, ${skipped} skipped, ${failed} failed (from ${candidatesCount} candidates)`);

  integrityReport.targetMakerBackfill = {
    name: 'relations.target_maker_extended backfill',
    sourceRows: candidatesCount, connected, skipped,
    expectedSkipped: 0,
    problematicSkipped: skippedMissingDocId + skippedMissingMaker,
    failed,
    skipBreakdown: { missingRelationDocumentId: skippedMissingDocId, missingMakerExtended: skippedMissingMaker },
  };

  logStepEnd(label);
}

async function clearAllRelations(strapi: Core.Strapi, selectedEndpoints: Set<string> | null = null) {
  const label = 'clear relations';
  logStepStart(label);
  const endpointFields: Record<string, Set<string>> = {};
  for (const link of RELATION_LINKS) {
    if (selectedEndpoints && !selectedEndpoints.has(link.sourceEndpoint)) continue;
    if (!endpointFields[link.sourceEndpoint]) endpointFields[link.sourceEndpoint] = new Set();
    endpointFields[link.sourceEndpoint].add(link.connectionField);
  }
  if (!selectedEndpoints || selectedEndpoints.has('relations')) {
    if (!endpointFields['relations']) endpointFields['relations'] = new Set();
    endpointFields['relations'].add('target_maker_extended');
  }

  for (const [endpoint, fieldSet] of Object.entries(endpointFields)) {
    const config = getConfigByEndpoint(endpoint);
    const fields = [...fieldSet];
    let cleared = 0, failed = 0;

    await forEachDocumentPage(strapi, config.uid, undefined, `clear ${endpoint}`, async (rows) => {
      for (const row of rows) {
        if (!row?.documentId) continue;
        const data = Object.fromEntries(fields.map((f) => [f, null]));
        try {
          if (!options.dryRun) await (strapi.documents as any)(config.uid).update({ documentId: row.documentId, data });
          cleared += 1;
        } catch (error: any) {
          failed += 1;
          console.error(`[clear] ${endpoint} failed for ${row.documentId}: ${error.message}`);
        }
      }
    });

    console.log(`[clear] ${endpoint}: cleared ${fields.join(', ')} for ${cleared} records (${failed} failed)`);
  }

  logStepEnd(label);
}

// ---------------------------------------------------------------------------
// Main entry point – called from src/index.ts bootstrap
// ---------------------------------------------------------------------------

export async function runCsvSync(strapi: Core.Strapi) {
  const mode = options.relationsOnly ? 'relations-only'
    : options.deleteOnly ? 'delete-only'
    : options.deleteExisting ? 'delete+import'
    : 'import';

  console.log(`[sync:csv] starting | mode=${mode} | csvDir=${options.csvDir}`);
  if (options.dryRun) console.log('[sync:csv] dry run enabled: no write operations will be sent');
  if (options.strictRelations) console.log('[sync:csv] strict relations mode: enabled');
  if (options.reportMissingTargets) console.log('[sync:csv] missing targets reporting: enabled');
  if (options.clearRelationsOnly) console.log('[sync:csv] clear relations: enabled');
  if (options.collections?.size) console.log(`[sync:csv] collections filter: ${[...options.collections].join(', ')}`);
  if (options.strictRelations && (options.skipRelations || options.deleteOnly)) {
    throw new Error('SYNC_CSV_STRICT requires relation linking (cannot combine with SYNC_CSV_SKIP_RELATIONS or SYNC_CSV_DELETE_ONLY).');
  }

  const selectedCollections = options.collections
    ? COLLECTIONS.filter((c) => options.collections!.has(c.name) || options.collections!.has(c.endpoint))
    : COLLECTIONS;
  const selectedEndpoints = new Set(selectedCollections.map((c) => c.endpoint));

  if (options.collections?.size && !selectedCollections.length) {
    throw new Error(`No matching collections for filter: ${[...options.collections].join(',')}`);
  }

  if (!options.relationsOnly && (options.deleteExisting || options.deleteOnly)) {
    for (const config of selectedCollections) {
      await deleteAllRecords(strapi, config);
    }
  }

  if (!options.relationsOnly && !options.deleteOnly) {
    for (const config of selectedCollections) {
      await uploadCollection(strapi, config);
    }
  }

  const shouldProcessTerms = selectedCollections.some((c) => c.endpoint === 'terms');
  if (!options.deleteOnly && shouldProcessTerms) {
    await enrichInstrumentTerms(strapi);
  }

  const shouldProcessInstrumentAssociations = selectedCollections.some((c) => c.endpoint === 'instruments-known' || c.endpoint === 'instruments-advertised' || c.endpoint === 'terms');
  if (!options.deleteOnly && shouldProcessInstrumentAssociations) {
    await syncInstrumentMakerTermAssociations(strapi);
  }

  if (!options.deleteOnly && !options.skipRelations) {
    if (options.clearRelationsOnly) {
      await clearAllRelations(strapi, options.collections?.size ? selectedEndpoints : null);
    }

    const relationLinksToRun = options.collections?.size
      ? RELATION_LINKS.filter((link) => selectedEndpoints.has(link.sourceEndpoint))
      : RELATION_LINKS;

    for (const link of relationLinksToRun) {
      await connectRelation(strapi, link);
    }

    const shouldRunTargetMakerSteps = !options.collections?.size || selectedEndpoints.has('relations');
    if (shouldRunTargetMakerSteps) {
      await connectTargetMakers(strapi);
      await backfillMissingTargetMakers(strapi);
    } else {
      console.log('[connect] relations -> makers-extended (target_maker_extended): skipped (relations not selected)');
    }

    const summary = printIntegrityReport();
    if (options.reportMissingTargets) printMissingTargetsReport();
    if (options.strictRelations && summary.hasIssues) {
      throw new Error(`[strict-relations] integrity check failed: ${summary.totalProblematicSkipped} problematic skipped, ${summary.totalFailed} failed.`);
    }
  }

  console.log('[sync:csv] complete.');
}
