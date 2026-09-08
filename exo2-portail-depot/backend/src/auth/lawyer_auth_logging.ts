import type { ApplicationLogger, LogLevel } from '../shared/logging/application_logger';

export const LAWYER_AUTH_LOG_CONTEXT = 'lawyer_auth';

// Verifie dans better-auth 1.7.3 (`api/routes/sign-in.mjs:319, 326, 333`) : la
// bibliotheque journalise trois messages DIFFERENTS selon la branche d'echec.
// La reponse HTTP, elle, est identique. Les journaux deviendraient donc
// l'oracle d'enumeration que la reponse refuse d'etre — et ils sont lus par
// plus de monde que la base.
export const DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES: readonly string[] = [
  'User not found',
  'Password not found',
  'Invalid password',
];

export const NEUTRAL_AUTHENTICATION_FAILURE_MESSAGE = 'echec de connexion avocat';

export function neutralize_authentication_failure_message(message: string): string {
  return DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES.includes(message.trim())
    ? NEUTRAL_AUTHENTICATION_FAILURE_MESSAGE
    : message;
}

type BetterAuthLogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

const LOG_LEVEL_BY_BETTER_AUTH_LEVEL: Readonly<Record<BetterAuthLogLevel, LogLevel>> = {
  debug: 'debug',
  info: 'info',
  success: 'info',
  warn: 'warn',
  error: 'error',
};

export interface BetterAuthLoggerOption {
  disabled?: boolean;
  log: (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void;
}

// BetterAuth ecrit sinon directement sur la console, hors de notre masquage des
// secrets et hors de la collecte : ses lignes seraient les seules du service a
// pouvoir contenir un jeton en clair.
export function build_lawyer_auth_logger(logger: ApplicationLogger): BetterAuthLoggerOption {
  return {
    log: (level: BetterAuthLogLevel, message: string): void => {
      logger[LOG_LEVEL_BY_BETTER_AUTH_LEVEL[level] ?? 'warn'](
        LAWYER_AUTH_LOG_CONTEXT,
        neutralize_authentication_failure_message(message),
      );
    },
  };
}
