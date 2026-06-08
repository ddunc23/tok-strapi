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

const dbFile = path.resolve(process.cwd(), process.env.DATABASE_FILENAME || '.tmp/data.db');

if (!fs.existsSync(dbFile)) {
  throw new Error(`SQLite DB file not found: ${dbFile}`);
}

const db = new Database(dbFile);

try {
  db.exec('BEGIN;');

  const rows = db.prepare('SELECT id, relation_id, target_maker_id FROM disambiguated_relations').all();

  const findMakerId = db.prepare(`
    SELECT id FROM makers_extended
    WHERE Maker_ID = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `);

  const findRelationId = db.prepare(`
    SELECT id FROM relations
    WHERE relation_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `);

  const clearMakerLink = db.prepare(
    'DELETE FROM disambiguated_relations_target_maker_extended_lnk WHERE disambiguated_relation_id = ?'
  );
  const setMakerLink = db.prepare(`
    INSERT OR IGNORE INTO disambiguated_relations_target_maker_extended_lnk
    (disambiguated_relation_id, maker_extended_id, disambiguated_relation_ord)
    VALUES (?, ?, 1)
  `);

  const clearRelationLink = db.prepare(
    'DELETE FROM disambiguated_relations_relation_lnk WHERE disambiguated_relation_id = ?'
  );
  const setRelationLink = db.prepare(`
    INSERT OR IGNORE INTO disambiguated_relations_relation_lnk
    (disambiguated_relation_id, relation_id)
    VALUES (?, ?)
  `);

  let makerLinked = 0;
  let relationLinked = 0;
  let missingMaker = 0;
  let missingRelation = 0;

  for (const row of rows) {
    if (row.target_maker_id !== null && row.target_maker_id !== undefined) {
      const maker = findMakerId.get(row.target_maker_id);
      if (maker?.id) {
        clearMakerLink.run(row.id);
        setMakerLink.run(row.id, maker.id);
        makerLinked += 1;
      } else {
        missingMaker += 1;
      }
    }

    if (row.relation_id !== null && row.relation_id !== undefined) {
      const relation = findRelationId.get(row.relation_id);
      if (relation?.id) {
        clearRelationLink.run(row.id);
        setRelationLink.run(row.id, relation.id);
        relationLinked += 1;
      } else {
        missingRelation += 1;
      }
    }
  }

  db.exec('COMMIT;');

  console.log(
    `[sqlite-relink] linked target_maker_extended=${makerLinked}, linked relation=${relationLinked}, missing makers-extended=${missingMaker}, missing relations=${missingRelation}`
  );
} catch (error) {
  db.exec('ROLLBACK;');
  throw error;
} finally {
  db.close();
}
