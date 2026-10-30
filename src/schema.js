import initialSql from '../migrations/001_initial.sql';
import teamAndPublishingSql from '../migrations/002_team_and_publishing.sql';

const MIGRATIONS = [
  { version: 1, sql: initialSql },
  { version: 2, sql: teamAndPublishingSql },
];
const LATEST_VERSION = MIGRATIONS.at(-1).version;

let schemaReady = null;

function statements(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function currentVersion(sql) {
  try {
    const rows = await sql`SELECT COALESCE(max(version), 1)::int AS version FROM schema_migrations`;
    return rows[0]?.version || 1;
  } catch {
    return 0;
  }
}

async function migrate(sql) {
  const version = await currentVersion(sql);
  if (version >= LATEST_VERSION) return;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    await sql.transaction(statements(migration.sql).map((statement) => sql.query(statement)));
  }
}

// Applies pending migrations once per Worker isolate; a failed attempt is retried on the next request.
export function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = migrate(sql).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
