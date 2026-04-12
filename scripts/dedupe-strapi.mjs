import fs from 'node:fs';
import path from 'node:path';

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

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const ALL_COLLECTIONS = [
  { endpoint: 'makers', keyFields: ['maker_id'] },
  { endpoint: 'addresses', keyFields: ['address_id'] },
  { endpoint: 'town-locations', keyFields: ['town_location_id'] },
  { endpoint: 'guilds', keyFields: ['guild_id'] },
  { endpoint: 'memberships', keyFields: ['membership_id'] },
  { endpoint: 'relations', keyFields: ['relation_id'] },
  { endpoint: 'disambiguated-relations', keyFields: ['relation_id', 'target_maker_id'] },
  { endpoint: 'instruments-known', keyFields: ['maker_id', 'inst_code', 'inst_name'] },
  { endpoint: 'instruments-advertised', keyFields: ['maker_id', 'inst_code', 'inst_name'] },
];

const selectedCollections = (() => {
  const raw = getArgValue('--collections');
  if (!raw) return ALL_COLLECTIONS;

  const selected = new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  return ALL_COLLECTIONS.filter((collection) => selected.has(collection.endpoint));
})();

const options = {
  dryRun: hasFlag('--dry-run'),
  jsonReport: hasFlag('--json-report') || !!getArgValue('--json-report'),
  jsonReportPath: getArgValue('--json-report') || process.env.DEDUPE_REPORT_PATH || null,
};

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

async function fetchAll(endpoint) {
  const requestedPageSize = 200;
  let page = 1;
  const allRows = [];
  let pagesWithoutData = 0;

  while (true) {
    const query = new URLSearchParams();
    query.set('pagination[page]', String(page));
    query.set('pagination[pageSize]', String(requestedPageSize));

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

function getFieldValue(record, fieldName) {
  if (record && fieldName in record) return record[fieldName];
  if (record?.attributes && fieldName in record.attributes) return record.attributes[fieldName];
  return null;
}

function getDocumentId(record) {
  return record?.documentId || record?.id || null;
}

function makeRecordKey(record, fields) {
  return fields
    .map((field) => {
      const value = getFieldValue(record, field);
      return value === null || value === undefined ? '' : String(value);
    })
    .join('::');
}

function getSortTimestamp(record) {
  return record?.createdAt || record?.attributes?.createdAt || '';
}

function getNumericId(record) {
  return Number.parseInt(String(record?.id ?? ''), 10) || Number.MAX_SAFE_INTEGER;
}

function sortCanonicalFirst(records) {
  return [...records].sort((a, b) => {
    const aTime = getSortTimestamp(a);
    const bTime = getSortTimestamp(b);

    if (aTime && bTime && aTime !== bTime) {
      return aTime.localeCompare(bTime);
    }

    const aId = getNumericId(a);
    const bId = getNumericId(b);
    if (aId !== bId) return aId - bId;

    return String(getDocumentId(a)).localeCompare(String(getDocumentId(b)));
  });
}

async function deleteEntry(endpoint, documentId) {
  if (options.dryRun) return;

  await strapiFetch(`${buildUrl(endpoint)}/${documentId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
}

async function dedupeCollection({ endpoint, keyFields }) {
  const rows = await fetchAll(endpoint);
  const grouped = new Map();
  let skippedMissingKey = 0;

  for (const row of rows) {
    const key = makeRecordKey(row, keyFields);
    if (!key || !key.replace(/:/g, '').trim()) {
      skippedMissingKey += 1;
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(row);
  }

  let duplicateGroups = 0;
  let deleted = 0;
  const groups = [];

  for (const [key, records] of grouped.entries()) {
    if (records.length <= 1) continue;

    duplicateGroups += 1;
    const ordered = sortCanonicalFirst(records);
    const canonical = ordered[0];
    const duplicates = ordered.slice(1);
    const removedDocumentIds = [];

    for (const duplicate of duplicates) {
      const duplicateDocumentId = getDocumentId(duplicate);
      if (!duplicateDocumentId) continue;

      await deleteEntry(endpoint, duplicateDocumentId);
      deleted += 1;
      removedDocumentIds.push(String(duplicateDocumentId));
    }

    const canonicalDocumentId = getDocumentId(canonical);
    groups.push({
      key,
      kept: canonicalDocumentId ? String(canonicalDocumentId) : null,
      removed: removedDocumentIds,
      removedCount: removedDocumentIds.length,
    });

    console.log(
      `[dedupe] ${endpoint}: key=${key} kept=${canonicalDocumentId} removed=${duplicates.length}`
    );
  }

  let remainingDuplicateGroups = duplicateGroups;
  if (!options.dryRun) {
    const afterRows = await fetchAll(endpoint);
    const afterCounts = new Map();

    for (const row of afterRows) {
      const key = makeRecordKey(row, keyFields);
      if (!key || !key.replace(/:/g, '').trim()) continue;
      afterCounts.set(key, (afterCounts.get(key) || 0) + 1);
    }

    remainingDuplicateGroups = [...afterCounts.values()].filter((count) => count > 1).length;
  }

  return {
    endpoint,
    keyFields,
    scanned: rows.length,
    duplicateGroups,
    deleted,
    skippedMissingKey,
    remainingDuplicateGroups,
    groups,
  };
}

function defaultReportPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), 'reports', `dedupe-strapi-${timestamp}.json`);
}

function writeJsonReport(report) {
  const reportPath = options.jsonReportPath
    ? path.resolve(process.cwd(), options.jsonReportPath)
    : defaultReportPath();

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

async function run() {
  if (!selectedCollections.length) {
    throw new Error('No matching collections selected. Check --collections argument values.');
  }

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Dry run: ${options.dryRun ? 'yes' : 'no'}`);
  console.log(`Collections: ${selectedCollections.map((item) => item.endpoint).join(', ')}`);

  const summaries = [];

  for (const collection of selectedCollections) {
    const summary = await dedupeCollection(collection);
    summaries.push(summary);
  }

  const totals = summaries.reduce(
    (acc, item) => {
      acc.scanned += item.scanned;
      acc.duplicateGroups += item.duplicateGroups;
      acc.deleted += item.deleted;
      return acc;
    },
    { scanned: 0, duplicateGroups: 0, deleted: 0 }
  );

  for (const item of summaries) {
    console.log(
      `[summary] ${item.endpoint}: scanned=${item.scanned}, duplicateGroups=${item.duplicateGroups}, deleted=${item.deleted}, skippedMissingKey=${item.skippedMissingKey}, remainingDuplicateGroups=${item.remainingDuplicateGroups}`
    );
  }

  console.log(
    `[summary] total: scanned=${totals.scanned}, duplicateGroups=${totals.duplicateGroups}, deleted=${totals.deleted}`
  );

  if (options.jsonReport) {
    const report = {
      generatedAt: new Date().toISOString(),
      dryRun: options.dryRun,
      baseUrl: BASE_URL,
      collections: selectedCollections.map((item) => item.endpoint),
      totals,
      summaries,
    };

    const reportPath = writeJsonReport(report);
    console.log(`[summary] JSON report written: ${reportPath}`);
  }

  if (!options.dryRun) {
    console.log('Deduplication complete. Re-run relation linking with: npm run sync:csv -- --relations-only');
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
