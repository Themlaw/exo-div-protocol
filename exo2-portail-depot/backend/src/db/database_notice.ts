import type { LogLevel } from '../shared/logging/application_logger';

// Ce que le pilote `postgres` passe a `onnotice` : le message NoticeResponse du
// protocole, decoupe champ par champ. Tous les champs sont optionnels — c'est
// le protocole qui decide de ce qu'il envoie, pas nous.
export interface DatabaseNotice {
  severity?: string;
  severity_local?: string;
  code?: string;
  message?: string;
  where?: string;
  detail?: string;
  hint?: string;
}

export type DatabaseNoticeRouting =
  | { kind: 'ignored' }
  | { kind: 'logged'; level: LogLevel };

// Codes emis a CHAQUE demarrage par les `CREATE ... IF NOT EXISTS` internes du
// migrator de drizzle. C'est le seul bruit reellement repetitif, et le seul
// qu'on se permet de taire — nommement, jamais par une regle large.
export const EXPECTED_MIGRATION_NOTICE_CODES: readonly string[] = [
  '42P06', // schema already exists, skipping
  '42P07', // relation already exists, skipping
  '42710', // object already exists, skipping
  '42701', // column already exists, skipping
];

// Un WARNING de Postgres voyage dans le MEME message NoticeResponse qu'un
// NOTICE : un `onnotice` vide ne tait pas seulement le bruit d'idempotence, il
// tait tous les avertissements du serveur — `there is no transaction in
// progress`, les depreciations, et tous les RAISE WARNING du plpgsql, dont
// graphile-worker fera un usage massif.
// C'est la SEVERITE qui decide, jamais le code seul : un code de la liste porte
// par un WARNING reste un avertissement.
const LOG_LEVEL_BY_NOTICE_SEVERITY: Readonly<Record<string, LogLevel>> = {
  DEBUG: 'debug',
  LOG: 'debug',
  INFO: 'debug',
  NOTICE: 'debug',
  WARNING: 'warn',
  ERROR: 'error',
  FATAL: 'error',
  PANIC: 'error',
};

export function route_database_notice(notice: DatabaseNotice): DatabaseNoticeRouting {
  const severity: string = (notice.severity ?? '').toUpperCase();
  const level: LogLevel | undefined = LOG_LEVEL_BY_NOTICE_SEVERITY[severity];

  // Une severite inconnue ou absente n'est pas tue : on ne fait taire que ce
  // qu'on a explicitement decide de faire taire.
  if (level === undefined) {
    return { kind: 'logged', level: 'warn' };
  }

  if (
    severity === 'NOTICE' &&
    notice.code !== undefined &&
    EXPECTED_MIGRATION_NOTICE_CODES.includes(notice.code)
  ) {
    return { kind: 'ignored' };
  }

  return { kind: 'logged', level };
}
