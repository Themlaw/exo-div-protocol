import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { route_database_notice, type DatabaseNotice } from './database_notice';
import type { ApplicationLogger } from '../shared/logging/application_logger';

export const DATABASE_LOG_CONTEXT = 'database';

// Jeton d'injection Nest. Un symbole plutot qu'une chaine : deux modules ne
// peuvent pas se marcher dessus par collision de nom.
export const DATABASE_CONNECTION: unique symbol = Symbol('DATABASE_CONNECTION');

export type ApplicationDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseConnection {
  database: ApplicationDatabase;
  // Fermeture explicite : sans elle, un test qui cree une application laisse
  // des sockets ouvertes et Jest ne rend jamais la main.
  close(): Promise<void>;
}

// Le pilote `postgres` ouvre par defaut jusqu'a 10 connexions. On le fixe
// explicitement : ce nombre est aussi le plafond de requetes simultanees que
// l'application peut servir, et le laisser implicite le rendrait invisible le
// jour ou le plafond de concurrence du login devra s'y accorder.
export const DATABASE_POOL_MAX_CONNECTIONS = 10;

// Sans `onnotice`, le pilote fait un `console.log` brut, hors de tout logger et
// invisible pour la collecte. Avec un `onnotice` vide, on tait aussi tous les
// WARNING du serveur, qui voyagent dans le meme message NoticeResponse que les
// NOTICE. On route donc par severite.
export function report_database_notice(
  notice: DatabaseNotice,
  logger: ApplicationLogger,
): void {
  const routing = route_database_notice(notice);
  if (routing.kind === 'ignored') {
    return;
  }

  logger[routing.level](DATABASE_LOG_CONTEXT, notice.message ?? 'notice Postgres sans message', {
    postgres_severity: notice.severity,
    postgres_code: notice.code,
    postgres_where: notice.where,
    postgres_detail: notice.detail,
    postgres_hint: notice.hint,
  });
}

export function open_database_connection(
  database_url: string,
  logger: ApplicationLogger,
): DatabaseConnection {
  const sql: postgres.Sql = postgres(database_url, {
    max: DATABASE_POOL_MAX_CONNECTIONS,
    onnotice: (notice: DatabaseNotice): void => {
      report_database_notice(notice, logger);
    },
  });

  return {
    database: drizzle(sql, { schema }),
    close: async (): Promise<void> => {
      await sql.end();
    },
  };
}
