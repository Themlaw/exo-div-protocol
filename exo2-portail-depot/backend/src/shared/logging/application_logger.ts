import type { NodeEnvironment } from '../node_environment';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Ordre de gravite croissante : un seuil laisse passer son niveau et tous ceux
// qui le suivent.
export const LOG_LEVELS_BY_SEVERITY: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Les champs libres accompagnant un evenement. `unknown` et non `any` : on
// serialise des valeurs dont on ne sait rien, et les tenir pour typees
// laisserait passer n'importe quoi sans controle.
export type LogFields = Readonly<Record<string, unknown>>;

export interface StructuredLogEntry {
  level: LogLevel;
  message: string;
  // Le sous-systeme emetteur : « database », « auth »... Il rend un flux
  // filtrable sans avoir a deviner d'apres le texte du message.
  context: string;
  timestamp: string;
  fields?: LogFields;
}

// Noms de champs dont la VALEUR n'est jamais journalisee. `memories/observabilite.md`
// l'exige pour le PIN et le token, et la meme regle vaut pour tout secret : les
// logs sont lus par plus de monde que la base. La correspondance se fait par
// inclusion et sans tenir compte de la casse — `plaintext_password`,
// `Authorization` et `access_link_token_pepper` doivent tous tomber.
export const REDACTED_FIELD_NAME_FRAGMENTS: readonly string[] = [
  'password',
  'motdepasse',
  'secret',
  'token',
  'pepper',
  'pin',
  'authorization',
  'cookie',
  'credential',
];

export const REDACTED_VALUE_PLACEHOLDER = '[redacted]';

// Un log doit rester lisible et borne. Sans plafond, un tableau de cent mille
// entrees ou une chaine d'un megaoctet fait d'une ligne de journal un vecteur
// de saturation disque, et rend illisible ce qu'on y cherchait.
export const LOG_VALUE_LIMITS = {
  max_depth: 8,
  max_array_items: 100,
  max_object_keys: 100,
  // Assez large pour qu'une pile d'appels survive entiere, assez etroit pour
  // qu'un corps de requete ne parte pas dans les journaux.
  max_string_length: 4000,
} as const;

export const TRUNCATED_VALUE_SUFFIX = '[truncated]';
export const CYCLIC_VALUE_PLACEHOLDER = '[cyclic]';
export const DEPTH_LIMIT_PLACEHOLDER = '[maximal depth reached  ]';

function is_redacted_field_name(field_name: string): boolean {
  const normalized_field_name: string = field_name.toLowerCase();
  return REDACTED_FIELD_NAME_FRAGMENTS.some((fragment: string): boolean =>
    normalized_field_name.includes(fragment),
  );
}

// Un mot de passe recopie dans une URL de connexion, un `password=...`, un
// jeton porteur. Masquer le message entier ferait perdre la seule information
// utile — on masque donc ce qui, DANS le texte, ressemble a un secret.
const SECRET_BEARING_TEXT_PATTERNS: readonly RegExp[] = [
  // scheme://utilisateur:motdepasse@hote
  /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi,
  // clef=valeur ou clef: valeur, ou la clef porte un des fragments sensibles
  /\b([a-z_]*(?:password|motdepasse|secret|token|pepper|pin|credential)[a-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
  /\b(bearer|basic)\s+[\w.\-~+/=]+/gi,
];

export function redact_secrets_in_text(text: string): string {
  return SECRET_BEARING_TEXT_PATTERNS.reduce(
    (masked_text: string, pattern: RegExp): string =>
      masked_text.replace(pattern, (whole_match: string, prefix: string): string =>
        prefix === undefined
          ? REDACTED_VALUE_PLACEHOLDER
          : `${prefix}${whole_match.startsWith(prefix) && /^[a-z]+$/i.test(prefix) && whole_match.includes(' ') ? ' ' : whole_match.includes('://') ? ':' : '='}${REDACTED_VALUE_PLACEHOLDER}${whole_match.endsWith('@') ? '@' : ''}`,
      ),
    text,
  );
}

function truncate_text(text: string): string {
  return text.length <= LOG_VALUE_LIMITS.max_string_length
    ? text
    : `${text.slice(0, LOG_VALUE_LIMITS.max_string_length)}${TRUNCATED_VALUE_SUFFIX}`;
}

// `Object.entries` ne voit que les proprietes ENUMERABLES. Sur une Error,
// `message` et `stack` ne le sont pas : une erreur journalisee rendait `{}`,
// c'est-a-dire une ligne de log d'apparence normale qui ne disait rien. Une
// Date, un Map et un Set rendaient `{}` pour la meme raison.
function describe_error(error: Error): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: redact_secrets_in_text(error.message),
  };
  if (typeof error.stack === 'string') {
    described.stack = redact_secrets_in_text(error.stack);
  }
  for (const [field_name, field_value] of Object.entries(error)) {
    if (field_name !== 'cause') {
      described[field_name] = field_value;
    }
  }
  if ('cause' in error && error.cause !== undefined) {
    described.cause = error.cause;
  }
  return described;
}

interface RedactionState {
  // Chaine d'ANCETRES et non ensemble des objets vus : un objet present deux
  // fois cote a cote n'est pas un cycle, et le signaler comme tel ferait perdre
  // une donnee reelle. On empile en descendant, on depile en remontant.
  ancestors: Set<object>;
  depth: number;
}

function redact_value(value: unknown, state: RedactionState): unknown {
  if (typeof value === 'bigint') {
    // JSON.stringify LEVE sur un BigInt : sans ce cas, le logger tuait son
    // appelant, exactement ce que la garde anti-cycle devait empecher.
    return value.toString();
  }
  if (typeof value === 'string') {
    return truncate_text(value);
  }
  if (typeof value === 'function') {
    return `[fonction ${value.name || 'anonyme'}]`;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (state.ancestors.has(value)) {
    return CYCLIC_VALUE_PLACEHOLDER;
  }
  if (state.depth >= LOG_VALUE_LIMITS.max_depth) {
    return DEPTH_LIMIT_PLACEHOLDER;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[date invalide]' : value.toISOString();
  }

  state.ancestors.add(value);
  const child_state: RedactionState = { ancestors: state.ancestors, depth: state.depth + 1 };
  try {
    if (value instanceof Error) {
      return redact_plain_object(describe_error(value), child_state);
    }
    if (value instanceof Map) {
      return redact_plain_object(Object.fromEntries(value.entries()), child_state);
    }
    if (value instanceof Set) {
      return redact_array([...value], child_state);
    }
    if (Array.isArray(value)) {
      return redact_array(value, child_state);
    }
    return redact_plain_object(value as Record<string, unknown>, child_state);
  } finally {
    // Depile : c'est ce qui distingue un cycle d'un simple partage.
    state.ancestors.delete(value);
  }
}

function redact_array(items: readonly unknown[], state: RedactionState): unknown[] {
  const kept_items: unknown[] = items
    .slice(0, LOG_VALUE_LIMITS.max_array_items)
    .map((item: unknown): unknown => redact_value(item, state));

  if (items.length > LOG_VALUE_LIMITS.max_array_items) {
    kept_items.push(
      `${TRUNCATED_VALUE_SUFFIX} ${items.length - LOG_VALUE_LIMITS.max_array_items} entrees de plus`,
    );
  }
  return kept_items;
}

function redact_plain_object(
  source: Record<string, unknown>,
  state: RedactionState,
): Record<string, unknown> {
  const entries: readonly [string, unknown][] = Object.entries(source);
  const redacted: Record<string, unknown> = {};

  for (const [field_name, field_value] of entries.slice(0, LOG_VALUE_LIMITS.max_object_keys)) {
    redacted[field_name] = is_redacted_field_name(field_name)
      ? REDACTED_VALUE_PLACEHOLDER
      : redact_value(field_value, state);
  }

  if (entries.length > LOG_VALUE_LIMITS.max_object_keys) {
    redacted[TRUNCATED_VALUE_SUFFIX] = `${entries.length - LOG_VALUE_LIMITS.max_object_keys} clefs de plus`;
  }
  return redacted;
}

// L'etat est cree ICI, a chaque appel : un suivi partage entre deux
// journalisations ferait passer pour cyclique un objet simplement journalise
// deux fois.
export function redact_log_fields(fields: LogFields): LogFields {
  return redact_plain_object(fields as Record<string, unknown>, {
    ancestors: new Set<object>(),
    depth: 0,
  });
}

export function should_emit_log_level(level: LogLevel, minimum_level: LogLevel): boolean {
  return (
    LOG_LEVELS_BY_SEVERITY.indexOf(level) >= LOG_LEVELS_BY_SEVERITY.indexOf(minimum_level)
  );
}

// Une ligne de JSON par evenement : c'est ce qui rend le flux applicatif
// exploitable par une collecte, la ou un texte libre demanderait de deviner sa
// propre grammaire.
export function format_log_entry(entry: StructuredLogEntry): string {
  // Le masquage a lieu ICI et pas seulement a la construction de l'entree :
  // c'est le dernier point de passage avant l'ecriture, donc le seul qu'on ne
  // puisse pas contourner par inadvertance.
  const serializable_entry = {
    level: entry.level,
    // Le message subit le meme traitement que les champs. Il n'est pas plus
    // sur : la passerelle de BetterAuth y verse des chaines entierement
    // choisies par l'appelant — « Invalid origin: ... » recopie un en-tete de
    // la requete — et une erreur de connexion Postgres y met son URL.
    message: truncate_text(redact_secrets_in_text(entry.message)),
    context: entry.context,
    timestamp: entry.timestamp,
    ...(entry.fields === undefined ? {} : { fields: redact_log_fields(entry.fields) }),
  };

  // JSON.stringify echappe les sauts de ligne : une entree reste une ligne,
  // meme quand le message en contient.
  return JSON.stringify(serializable_entry);
}

// Pas de variable d'environnement dediee : un niveau reglable a chaud est une
// facon d'activer le debug en production sans le decider, et c'est la que le
// risque de fuite est le plus grand.
export function resolve_minimum_log_level(node_environment: NodeEnvironment): LogLevel {
  return node_environment === 'production' ? 'info' : 'debug';
}

export interface ApplicationLogger {
  debug(context: string, message: string, fields?: LogFields): void;
  info(context: string, message: string, fields?: LogFields): void;
  warn(context: string, message: string, fields?: LogFields): void;
  error(context: string, message: string, fields?: LogFields): void;
}

export type LogLineWriter = (line: string) => void;

export class StructuredApplicationLogger implements ApplicationLogger {
  constructor(
    private readonly minimum_level: LogLevel,
    // Injecte plutot que code en dur : c'est ce qui rend le logger observable
    // dans un test sans avoir a intercepter `console`.
    private readonly write_line: LogLineWriter = (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    private readonly read_now: () => Date = (): Date => new Date(),
  ) {}

  debug(context: string, message: string, fields?: LogFields): void {
    this.emit('debug', context, message, fields);
  }

  info(context: string, message: string, fields?: LogFields): void {
    this.emit('info', context, message, fields);
  }

  warn(context: string, message: string, fields?: LogFields): void {
    this.emit('warn', context, message, fields);
  }

  error(context: string, message: string, fields?: LogFields): void {
    this.emit('error', context, message, fields);
  }

  private emit(
    level: LogLevel,
    context: string,
    message: string,
    fields: LogFields | undefined,
  ): void {
    if (!should_emit_log_level(level, this.minimum_level)) {
      return;
    }
    this.write_line(
      format_log_entry({
        level,
        message,
        context,
        timestamp: this.read_now().toISOString(),
        fields,
      }),
    );
  }
}
