import type {
  ApplicationLogger,
  LogFields,
  LogLevel,
} from '../../src/shared/logging/application_logger';

export interface CapturedLogEntry {
  level: LogLevel;
  context: string;
  message: string;
  fields?: LogFields;
}

export interface CapturingLogger extends ApplicationLogger {
  captured_entries: readonly CapturedLogEntry[];
  entries_at_level(level: LogLevel): readonly CapturedLogEntry[];
}

// Un logger qui capture plutot qu'un logger muet : un test doit pouvoir
// affirmer qu'un avertissement du serveur EST remonte, pas seulement qu'il n'a
// pas fait planter l'application.
export function build_capturing_logger(): CapturingLogger {
  const captured_entries: CapturedLogEntry[] = [];

  const record =
    (level: LogLevel) =>
    (context: string, message: string, fields?: LogFields): void => {
      captured_entries.push({ level, context, message, fields });
    };

  return {
    captured_entries,
    entries_at_level: (level: LogLevel): readonly CapturedLogEntry[] =>
      captured_entries.filter((entry: CapturedLogEntry): boolean => entry.level === level),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}
