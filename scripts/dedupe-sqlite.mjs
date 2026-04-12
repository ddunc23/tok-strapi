import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
  for (const rawLine of content.split(/\r?\n/)) {
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

const ALL_COLLECTIONS = [
  { table: 'makers', keyColumns: ['maker_id'] },
  { table: 'addresses', keyColumns: ['address_id'] },
  { table: 'town_locations', keyColumns: ['town_location_id'] },
  { table: 'guilds', keyColumns: ['guild_id'] },
  { table: 'memberships', keyColumns: ['membership_id'] },
  { table: 'relations', keyColumns: ['relation_id'] },
  { table: 'disambiguated_relations', keyColumns: ['relation_id', 'target_maker_id'] },
  { table: 'instruments_known', keyColumns: ['maker_id', 'inst_code', 'inst_name'] },
  { table: 'instruments_advertised', keyColumns: ['maker_id', 'inst_code', 'inst_name'] },
];

const selectedCollections = (() => {
  const raw = getArgValue('--collections');
  if (!raw) return ALL_COLLECTIONS;

  const selected = new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/-/g, '_'))
  );

  return ALL_COLLECTIONS.filter((collection) => selected.has(collection.table));
})();

const options = {
  dryRun: hasFlag('--dry-run'),
  jsonReport: hasFlag('--json-report') || !!getArgValue('--json-report'),
  jsonReportPath: getArgValue('--json-report') || process.env.DEDUPE_REPORT_PATH || null,
};

const dbFile = path.resolve(
  process.cwd(),
  process.env.DATABASE_FILENAME || getArgValue('--db-file') || '.tmp/data.db'
);

function defaultReportPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), 'reports', `dedupe-sqlite-${timestamp}.json`);
}

function writeJsonReport(report) {
  const reportPath = options.jsonReportPath
    ? path.resolve(process.cwd(), options.jsonReportPath)
    : defaultReportPath();

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName});`).all();
}

function getAllTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
    .all()
    .map((row) => row.name);
}

function buildKey(row, keyColumns) {
  const values = keyColumns.map((column) => row[column]);

  const hasMissing = values.some(
    (value) => value === null || value === undefined || String(value).trim() === ''
  );
  if (hasMissing) return null;

  return values.map((value) => String(value)).join('::');
}

function getReferenceMap(db, parentTable) {
  const referenceMap = [];

  for (const tableName of getAllTables(db)) {
    const fkRows = db.prepare(`PRAGMA foreign_key_list(${tableName});`).all();
    for (const fk of fkRows) {
      if (fk.table !== parentTable) continue;
      if (fk.to !== 'id') continue;

      referenceMap.push({
        table: tableName,
        fromColumn: fk.from,
      });
    }
  }

  return referenceMap;
}

function remapReferences(db, reference, duplicateId, canonicalId) {
  const columnInfo = tableColumns(db, reference.table);
  const writableColumns = columnInfo.filter((column) => column.pk === 0).map((column) => column.name);

  if (!writableColumns.length) {
    return { insertedOrIgnored: 0, deletedOldRefs: 0 };
  }

  const selectColumns = writableColumns
    .map((column) => (column === reference.fromColumn ? '? AS "' + column + '"' : `"${column}"`))
    .join(', ');

  const insertColumns = writableColumns.map((column) => `"${column}"`).join(', ');

  const insertSql = `
    INSERT OR IGNORE INTO "${reference.table}" (${insertColumns})
    SELECT ${selectColumns}
    FROM "${reference.table}"
    WHERE "${reference.fromColumn}" = ?
  `;

  const insertResult = db.prepare(insertSql).run(canonicalId, duplicateId);

  const deleteSql = `DELETE FROM "${reference.table}" WHERE "${reference.fromColumn}" = ?`;
  const deleteResult = db.prepare(deleteSql).run(duplicateId);

  return {
    insertedOrIgnored: insertResult.changes,
    deletedOldRefs: deleteResult.changes,
  };
}

function dedupeTable(db, { table, keyColumns }) {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  const groups = new Map();
  let skippedMissingKey = 0;

  for (const row of rows) {
    const key = buildKey(row, keyColumns);
    if (!key) {
      skippedMissingKey += 1;
      continue;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(row);
  }

  const references = getReferenceMap(db, table);

  let duplicateGroups = 0;
  let deleted = 0;
  let referenceUpdates = 0;
  const groupDetails = [];

  for (const [key, duplicateRows] of groups.entries()) {
    if (duplicateRows.length <= 1) continue;

    duplicateGroups += 1;

    const ordered = [...duplicateRows].sort((a, b) => {
      if (a.created_at && b.created_at && a.created_at !== b.created_at) {
        return String(a.created_at).localeCompare(String(b.created_at));
      }

      return Number(a.id) - Number(b.id);
    });

    const canonical = ordered[0];
    const duplicates = ordered.slice(1);

    const removed = [];

    for (const duplicate of duplicates) {
      for (const reference of references) {
        const remap = remapReferences(db, reference, duplicate.id, canonical.id);
        referenceUpdates += remap.deletedOldRefs;
      }

      const deleteResult = db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(duplicate.id);
      deleted += deleteResult.changes;
      removed.push(String(duplicate.id));
    }

    groupDetails.push({
      key,
      kept: String(canonical.id),
      removed,
      removedCount: removed.length,
    });
  }

  const remainingDuplicateGroups = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM (
        SELECT ${keyColumns.map((column) => `"${column}"`).join(', ')}
        FROM "${table}"
        WHERE ${keyColumns
          .map((column) => `"${column}" IS NOT NULL AND TRIM(CAST("${column}" AS TEXT)) <> ''`)
          .join(' AND ')}
        GROUP BY ${keyColumns.map((column) => `"${column}"`).join(', ')}
        HAVING COUNT(*) > 1
      )
    `
    )
    .get().count;

  return {
    table,
    keyColumns,
    scanned: rows.length,
    duplicateGroups,
    deleted,
    skippedMissingKey,
    remainingDuplicateGroups,
    referenceUpdates,
    groups: groupDetails,
  };
}

function run() {
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Database file not found: ${dbFile}`);
  }

  if (!selectedCollections.length) {
    throw new Error('No matching collections selected. Check --collections argument values.');
  }

  const db = new Database(dbFile);

  try {
    console.log(`DB file: ${dbFile}`);
    console.log(`Dry run: ${options.dryRun ? 'yes' : 'no'}`);
    console.log(`Collections: ${selectedCollections.map((item) => item.table).join(', ')}`);

    if (options.dryRun) {
      db.exec('BEGIN IMMEDIATE;');
    } else {
      db.exec('BEGIN;');
    }

    const summaries = [];

    for (const collection of selectedCollections) {
      const summary = dedupeTable(db, collection);
      summaries.push(summary);

      console.log(
        `[summary] ${summary.table}: scanned=${summary.scanned}, duplicateGroups=${summary.duplicateGroups}, deleted=${summary.deleted}, skippedMissingKey=${summary.skippedMissingKey}, remainingDuplicateGroups=${summary.remainingDuplicateGroups}, referenceUpdates=${summary.referenceUpdates}`
      );
    }

    const totals = summaries.reduce(
      (acc, item) => {
        acc.scanned += item.scanned;
        acc.duplicateGroups += item.duplicateGroups;
        acc.deleted += item.deleted;
        acc.skippedMissingKey += item.skippedMissingKey;
        acc.remainingDuplicateGroups += item.remainingDuplicateGroups;
        acc.referenceUpdates += item.referenceUpdates;
        return acc;
      },
      {
        scanned: 0,
        duplicateGroups: 0,
        deleted: 0,
        skippedMissingKey: 0,
        remainingDuplicateGroups: 0,
        referenceUpdates: 0,
      }
    );

    if (options.dryRun) {
      db.exec('ROLLBACK;');
      console.log('Dry run complete: transaction rolled back.');
    } else {
      db.exec('COMMIT;');
      console.log('Database-level dedupe committed.');
    }

    console.log(
      `[summary] total: scanned=${totals.scanned}, duplicateGroups=${totals.duplicateGroups}, deleted=${totals.deleted}, skippedMissingKey=${totals.skippedMissingKey}, remainingDuplicateGroups=${totals.remainingDuplicateGroups}, referenceUpdates=${totals.referenceUpdates}`
    );

    if (options.jsonReport) {
      const report = {
        generatedAt: new Date().toISOString(),
        dryRun: options.dryRun,
        dbFile,
        collections: selectedCollections.map((item) => item.table),
        totals,
        summaries,
      };
      const reportPath = writeJsonReport(report);
      console.log(`[summary] JSON report written: ${reportPath}`);
    }
  } finally {
    db.close();
  }
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
