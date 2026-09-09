import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { build_capturing_logger } from '../../helpers/capturing_logger';
import {
  open_database_connection,
  type DatabaseConnection,
} from '../../../src/db/database_connection';
import {
  run_database_migrations,
  resolve_migrations_folder,
} from '../../../src/db/run_database_migrations';
import { auth_user } from '../../../src/db/schema';

const DATABASE_URL: string | undefined = process.env.DATABASE_URL;

// Lu dans le journal plutot qu'ecrit en dur : un nombre en dur devrait etre
// ajuste a chaque migration ajoutee, et finirait par l'etre sans etre relu.
async function count_migrations_in_journal(): Promise<number> {
  const journal_path: string = join(resolve_migrations_folder(), 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journal_path, 'utf8')) as {
    entries: readonly unknown[];
  };
  return journal.entries.length;
}

function assert_not_running_against_production(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      "Ces tests creent et suppriment des bases : refus de s'executer avec NODE_ENV=production",
    );
  }
}

function require_database_url(): string {
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL est requis : ces tests migrent un vrai Postgres');
  }
  return DATABASE_URL;
}

// Chaque test travaille sur SA base, creee et detruite : une migration se teste
// sur une base vierge, et deux tests qui partageraient la meme ne testeraient
// plus la migration mais l'ordre dans lequel Jest les a lances.
function build_disposable_database_url(base_url: string, database_name: string): string {
  const url = new URL(base_url);
  url.pathname = `/${database_name}`;
  return url.toString();
}

describe('migrations de base de donnees', () => {
  let administrative_sql: postgres.Sql;
  let base_url: string;
  let disposable_database_name: string;
  let disposable_database_url: string;
  const opened_connections: DatabaseConnection[] = [];

  beforeAll(() => {
    assert_not_running_against_production();
    base_url = require_database_url();
    administrative_sql = postgres(base_url, { max: 1 });
  });

  afterAll(async () => {
    await administrative_sql?.end();
  });

  beforeEach(async () => {
    disposable_database_name = `migration_test_${randomUUID().replace(/-/g, '')}`;
    await administrative_sql.unsafe(`CREATE DATABASE "${disposable_database_name}"`);
    disposable_database_url = build_disposable_database_url(
      base_url,
      disposable_database_name,
    );
  });

  afterEach(async () => {
    await Promise.all(
      opened_connections.splice(0).map((connection) => connection.close()),
    );
    await administrative_sql.unsafe(`DROP DATABASE IF EXISTS "${disposable_database_name}"`);
  });

  function open_tracked_connection(): DatabaseConnection {
    const connection = open_database_connection(disposable_database_url, build_capturing_logger());
    opened_connections.push(connection);
    return connection;
  }

  async function read_object_names(): Promise<{
    schemas: readonly string[];
    tables: readonly string[];
  }> {
    const inspection_sql = postgres(disposable_database_url, { max: 1 });
    try {
      const schema_rows = await inspection_sql<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE nspname IN ('auth', 'deposit', 'security', 'drizzle')
        ORDER BY nspname
      `;
      const table_rows = await inspection_sql<{ schemaname: string; tablename: string }[]>`
        SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('auth', 'deposit', 'security') ORDER BY schemaname, tablename
      `;
      return {
        schemas: schema_rows.map((row) => row.nspname),
        tables: table_rows.map((row) => `${row.schemaname}.${row.tablename}`),
      };
    } finally {
      await inspection_sql.end();
    }
  }

  it('le dossier de migrations resolu contient bien un journal : sans lui le migrator ne trouverait rien', async () => {
    await expect(
      access(join(resolve_migrations_folder(), 'meta', '_journal.json')),
    ).resolves.toBeUndefined();
  });

  it('une base vierge recoit les deux schemas et toutes les tables', async () => {
    const { database } = open_tracked_connection();

    await run_database_migrations(database);

    const { schemas, tables } = await read_object_names();
    expect(schemas).toEqual(['auth', 'deposit', 'drizzle', 'security']);
    expect(tables).toEqual([
      'auth.account',
      'auth.session',
      'auth.user',
      'auth.verification',
      'deposit.access_link',
      'deposit.deposit_request',
      'deposit.expected_document',
      'security.authentication_failure_by_ip',
      'security.lawyer_login_failure_by_account',
      'security.lawyer_login_failure_by_account_and_ip',
    ]);
  });

  it('les contraintes de normalisation sont bien en place apres migration', async () => {
    const { database } = open_tracked_connection();
    await run_database_migrations(database);

    const inspection_sql = postgres(disposable_database_url, { max: 1 });
    try {
      await expect(
        inspection_sql`INSERT INTO auth."user" (id, name, email) VALUES ('u1', 'A', 'Demo@X.fr')`,
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await inspection_sql.end();
    }
  });

  it('rejouer les migrations ne change rien et ne leve pas : un redemarrage est frequent', async () => {
    const { database } = open_tracked_connection();

    await run_database_migrations(database);
    await expect(run_database_migrations(database)).resolves.toBeUndefined();

    const inspection_sql = postgres(disposable_database_url, { max: 1 });
    try {
      const applied = await inspection_sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
      `;
      expect(Number(applied[0]?.count)).toBe(await count_migrations_in_journal());
    } finally {
      await inspection_sql.end();
    }
  });

  // Le migrator de drizzle-orm lit la derniere migration appliquee HORS
  // transaction. Deux instances qui demarrent ensemble se croient donc toutes
  // deux seules, et `CREATE SCHEMA "auth"` sans IF NOT EXISTS fait planter la
  // perdante. Meme famille de faute que les deux install.sh simultanes.
  it('deux instances qui demarrent simultanement migrent sans que l une plante', async () => {
    const first_connection = open_tracked_connection();
    const second_connection = open_tracked_connection();

    const outcomes = await Promise.allSettled([
      run_database_migrations(first_connection.database),
      run_database_migrations(second_connection.database),
    ]);

    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toEqual([]);

    const { tables } = await read_object_names();
    expect(tables).toHaveLength(10);
  });

  it('quatre demarrages simultanes n appliquent quand meme chaque migration une seule fois', async () => {
    const connections = [
      open_tracked_connection(),
      open_tracked_connection(),
      open_tracked_connection(),
      open_tracked_connection(),
    ];

    await Promise.all(
      connections.map((connection) => run_database_migrations(connection.database)),
    );

    const inspection_sql = postgres(disposable_database_url, { max: 1 });
    try {
      const applied = await inspection_sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
      `;
      expect(Number(applied[0]?.count)).toBe(await count_migrations_in_journal());
    } finally {
      await inspection_sql.end();
    }
  });

  it('la connexion expose le schema : une requete typee sur une table du domaine fonctionne', async () => {
    const { database } = open_tracked_connection();
    await run_database_migrations(database);

    await expect(database.select().from(auth_user)).resolves.toEqual([]);
  });

  it('close libere reellement les connexions : sans cela Jest ne rend jamais la main', async () => {
    const connection = open_database_connection(disposable_database_url, build_capturing_logger());
    await run_database_migrations(connection.database);

    await expect(connection.close()).resolves.toBeUndefined();
    await expect(connection.database.execute('SELECT 1')).rejects.toBeDefined();
  });
});

// Verifie contre un vrai Postgres que le routage ne se contente pas d'etre
// correct en unitaire : c'est le pilote qui decide de ce qu'il passe a
// `onnotice`, et le contrat s'observe ici.
describe('remontee des notices Postgres', () => {
  let base_url: string;
  let disposable_database_name: string;
  let administrative_sql: postgres.Sql;

  beforeAll(() => {
    assert_not_running_against_production();
    base_url = require_database_url();
    administrative_sql = postgres(base_url, { max: 1 });
  });

  afterAll(async () => {
    await administrative_sql?.end();
  });

  beforeEach(async () => {
    disposable_database_name = `notice_test_${randomUUID().replace(/-/g, '')}`;
    await administrative_sql.unsafe(`CREATE DATABASE "${disposable_database_name}"`);
  });

  afterEach(async () => {
    await administrative_sql.unsafe(`DROP DATABASE IF EXISTS "${disposable_database_name}"`);
  });

  function open_with_capturing_logger(): {
    connection: ReturnType<typeof open_database_connection>;
    logger: ReturnType<typeof build_capturing_logger>;
  } {
    const logger = build_capturing_logger();
    const connection = open_database_connection(
      build_disposable_database_url(base_url, disposable_database_name),
      logger,
    );
    return { connection, logger };
  }

  it("un WARNING du serveur remonte en warn : c'est ce qu'un onnotice vide faisait disparaitre", async () => {
    const { connection, logger } = open_with_capturing_logger();

    try {
      await connection.database.execute(
        "DO $$ BEGIN RAISE WARNING 'avertissement de test'; END $$",
      );
    } finally {
      await connection.close();
    }

    const warnings = logger.entries_at_level('warn');
    expect(warnings.map((entry) => entry.message)).toContain('avertissement de test');
    expect(warnings[0]?.context).toBe('database');
  });

  it('un RAISE NOTICE remonte en debug plutot que d etre perdu', async () => {
    const { connection, logger } = open_with_capturing_logger();

    try {
      await connection.database.execute("DO $$ BEGIN RAISE NOTICE 'notice de test'; END $$");
    } finally {
      await connection.close();
    }

    expect(logger.entries_at_level('debug').map((entry) => entry.message)).toContain(
      'notice de test',
    );
  });

  it("le bruit d'idempotence des migrations n'est PAS journalise : c'est le seul qu'on se permet de taire", async () => {
    const { connection, logger } = open_with_capturing_logger();

    try {
      await run_database_migrations(connection.database);
      const entries_after_first_run = logger.captured_entries.length;
      await run_database_migrations(connection.database);

      expect(logger.captured_entries).toHaveLength(entries_after_first_run);
    } finally {
      await connection.close();
    }
  });
});
