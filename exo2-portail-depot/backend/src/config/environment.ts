import {
  is_valid_node_environment,
  type NodeEnvironment,
} from '../shared/node_environment';
import {
  find_lawyer_password_length_violation,
  has_lawyer_email_shape,
  is_lawyer_email_too_long,
  normalize_lawyer_email,
} from '../shared/lawyer_credentials';

// Les noms sont fixes ICI, et nulle part ailleurs : `.env.example`, install.sh
// et les tests s'y referent tous. Sans source unique, chacun devine les siens et
// l'application demarre avec une variable que personne ne renseigne.
export const ENVIRONMENT_VARIABLE_NAMES = {
  node_environment: 'NODE_ENV',
  database_url: 'DATABASE_URL',
  access_link_token_pepper: 'ACCESS_LINK_TOKEN_PEPPER',
  internal_storage_webhook_secret: 'INTERNAL_STORAGE_WEBHOOK_SECRET',
  minio_endpoint: 'MINIO_ENDPOINT',
  clamav_endpoint: 'CLAMAV_ENDPOINT',
  minio_root_user: 'MINIO_ROOT_USER',
  minio_root_password: 'MINIO_ROOT_PASSWORD',
  demo_lawyer_email: 'DEMO_LAWYER_EMAIL',
  demo_lawyer_password: 'DEMO_LAWYER_PASSWORD',
  trusted_proxy_hop_count: 'TRUSTED_PROXY_HOP_COUNT',
  public_base_url: 'PUBLIC_BASE_URL',
  http_port: 'PORT',
  worker_metrics_port: 'WORKER_METRICS_PORT',
  lawyer_auth_secret: 'BETTER_AUTH_SECRET',
} as const satisfies Record<keyof ApplicationEnvironment, string>;

// Les seules variables a porter une valeur par defaut, donc les seules a ne pas
// etre requises : un port d'ecoute est un detail de deploiement, pas un secret
// ni une decision de securite. Tout le reste doit etre fourni explicitement.
export const OPTIONAL_ENVIRONMENT_VARIABLES: readonly string[] = [
  ENVIRONMENT_VARIABLE_NAMES.http_port,
  ENVIRONMENT_VARIABLE_NAMES.worker_metrics_port,
];

export const REQUIRED_ENVIRONMENT_VARIABLES: readonly string[] = Object.values(
  ENVIRONMENT_VARIABLE_NAMES,
).filter((variable_name: string): boolean =>
  !OPTIONAL_ENVIRONMENT_VARIABLES.includes(variable_name),
);

export interface ApplicationEnvironment {
  node_environment: NodeEnvironment;
  database_url: string;
  access_link_token_pepper: string;
  // Jeton porteur envoye par MinIO dans l'en-tete Authorization de ses
  // notifications d'objet. MinIO ne SIGNE rien : le corps n'est pas authentifie,
  // donc ce secret n'est qu'une deuxieme barriere — la premiere est l'isolation
  // reseau, la route n'etant pas publiee par Traefik. Sa comparaison doit se
  // faire a temps constant, ce qu'une vraie signature n'aurait pas exige.
  internal_storage_webhook_secret: string;
  minio_endpoint: string;
  // Ou joindre clamd, sous la forme `tcp://hote:port`. Une variable et non une
  // constante : le scanner est un service voisin, et son adresse est une
  // decision de deploiement au meme titre que celle de MinIO.
  clamav_endpoint: string;
  minio_root_user: string;
  minio_root_password: string;
  demo_lawyer_email: string;
  demo_lawyer_password: string;
  // Nombre de relais de confiance a remonter dans X-Forwarded-For. Obligatoire
  // et non optionnel : c'est le parametre le plus sensible de la limitation par
  // adresse, et une valeur absente ou illisible ferait soit retomber
  // silencieusement sur l'adresse directe, soit lever sur chaque connexion.
  // `0` est legitime — c'est le mode degrade, ou le proxy frontal ne peut pas
  // ajouter l'en-tete.
  trusted_proxy_hop_count: number;
  // URL publique du portail. Elle fixe l'origine de confiance de
  // l'authentification — quelles pages ont le droit de poster vers l'API — et
  // le domaine du cookie de session. Deduite de l'en-tete `Host`, elle serait
  // choisie par le client lui-meme : c'est une decision de deploiement, donc
  // une variable.
  public_base_url: string;
  // Secret de signature des cookies de session. Sans lui, BetterAuth retombe
  // sur une constante publiee sur npm : quiconque la connait forge un cookie de
  // session valide. Le nom est celui que la bibliotheque lit dans
  // l'environnement, pour qu'une valeur posee la ne puisse pas diverger.
  lawyer_auth_secret: string;
  // Port d'ecoute HTTP. `PORT` est le nom que tout l'ecosysteme attend.
  http_port: number;
  // Port sur lequel le travailleur expose ses metriques. Il ne sert aucune
  // requete metier : ce port n'est publie que sur le reseau interne, et le
  // collecteur est le seul a l'atteindre.
  worker_metrics_port: number;
}

export type EnvironmentViolationReason =
  | 'missing'
  | 'malformed'
  // Une valeur de developpement qui atteint la production est un secret que
  // tout le monde connait, et elle passe tous les controles de forme.
  | 'development_value_in_production';

export interface EnvironmentViolation {
  variable: string;
  reason: EnvironmentViolationReason;
}

// L'application refuse de demarrer plutot que de casser a la premiere requete :
// une panne obscure en production devient un message clair au demarrage, et
// install.sh devient diagnosticable.
export class InvalidEnvironmentError extends Error {
  constructor(readonly violations: readonly EnvironmentViolation[]) {
    super(
      `Configuration invalide : ${violations
        .map((violation) => `${violation.variable} (${violation.reason})`)
        .join(', ')}`,
    );
    this.name = 'InvalidEnvironmentError';
  }
}

// Longueurs comptees en CARACTERES, et install.sh genere de l'hexadecimal :
// 64 caracteres hex valent 32 octets, soit la taille de sortie de SHA-256, qui
// est le plancher raisonnable pour une clef HMAC-SHA256 (RFC 2104 ; au-dela de
// 64 octets la clef est de toute facon re-hachee). Passer install.sh en base64url
// changerait ce compte — 32 octets n'y font que 43 caracteres — et ces
// constantes devraient suivre.
export const MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH = 64;

export const MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH = 64;

// Identifiant par defaut documente de MinIO, donc le copier-coller le plus
// probable de tous.
export const MINIO_DEFAULT_ROOT_CREDENTIAL = 'minioadmin';

// 64 caracteres, comme le poivre et le secret du webhook : ce secret signe les
// cookies de session, il n'a aucune raison d'etre plus faible.
export const MINIMUM_LAWYER_AUTH_SECRET_LENGTH = 64;

// La valeur sur laquelle better-auth retombe quand aucun secret n'est fourni.
// Elle est publiee dans le paquet npm : la refuser explicitement evite qu'elle
// arrive ici par recopie d'un exemple trouve en ligne.
export const DEFAULT_BETTER_AUTH_SECRET = 'better-auth-secret-12345678901234567890';

// Fragments qu'on ecrit machinalement en developpement et qui ne doivent jamais
// atteindre la production. La comparaison est une INCLUSION, pas une egalite :
// une liste d'egalites strictes ne coute rien a contourner (`changeme1`), et
// c'est precisement ce que fait quelqu'un de presse.
//
// L'inclusion interdit en revanche les fragments courts et courants. `test` et
// `portail` ont ete retires pour cette raison : « attestation » contient
// « test », et « portail » est le nom du projet, present dans des identifiants
// legitimes. `admin` de meme — `portail-admin` est un nom d'utilisateur
// plausible en production.
//
// Faux positif assume : la phrase de passe generee par install.sh pourrait
// contenir l'un de ces mots. L'application refuserait alors de demarrer avec un
// message clair, et il suffirait de relancer la generation — nettement moins
// grave que l'inverse.
export const FORBIDDEN_PRODUCTION_PLACEHOLDER_FRAGMENTS: readonly string[] = [
  'changeme',
  'change-me',
  'change_me',
  'a-changer',
  'tochange',
  'password',
  'motdepasse',
  'passwd',
  'secret',
  'azerty',
  'qwerty',
  '123456',
  'default',
  'example',
  'todo',
  MINIO_DEFAULT_ROOT_CREDENTIAL,
];

// En production, la base et MinIO sont joints par leur nom de service Docker :
// une adresse de bouclage trahit un .env de developpement recopie tel quel.
//
// Une liste de chaines litterales ne suffit pas : `postgres:` n'etant pas un
// schema « special » au sens WHATWG, `new URL()` ne canonicalise pas l'hote
// IPv4, et `127.1`, `2130706433`, `0177.0.0.1` ou `localhost.` passaient tous
// alors qu'ils resolvent vers la boucle locale. On decide donc sur la valeur
// numerique de l'adresse, pas sur son ecriture.
const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '::1', '::'];

// Domaines reserves a la documentation et aux essais (RFC 2606 / 6761). Un
// compte avocat de demonstration ne doit pas en porter en production.
const NON_DELIVERABLE_EMAIL_DOMAIN_SUFFIXES: readonly string[] = [
  '.test',
  '.local',
  '.invalid',
  '.localhost',
  '.example',
  'example.com',
  'example.org',
  'example.net',
];

function is_postgres_database_url(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

// Volontairement strict : `Number()` accepte '1e3', ' 1 ' et '0x1', et rend NaN
// sur '' — autant de valeurs qui produiraient une limitation par adresse
// silencieusement fausse, voire une TypeError sur chaque connexion. Seule une
// suite de chiffres est acceptee.
const NON_NEGATIVE_INTEGER_SHAPE = /^\d+$/;

function parse_non_negative_integer(value: string): number | null {
  if (!NON_NEGATIVE_INTEGER_SHAPE.test(value)) {
    return null;
  }
  const parsed: number = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function contains_forbidden_production_placeholder(value: string): boolean {
  const normalized_value: string = value.trim().toLowerCase();
  return FORBIDDEN_PRODUCTION_PLACEHOLDER_FRAGMENTS.some((fragment: string): boolean =>
    normalized_value.includes(fragment),
  );
}

// Rend l'entier 32 bits d'un hote ecrit en IPv4, quelle que soit sa notation :
// decimale pointee, entier unique, octal, hexadecimal, formes courtes. C'est
// exactement ce que fait `inet_addr`, et ce que fait le resolveur du systeme.
function parse_ipv4_host_as_integer(hostname: string): number | null {
  const parts: readonly string[] = hostname.split('.');
  if (parts.length === 0 || parts.length > 4) {
    return null;
  }

  const part_values: number[] = [];
  for (const part of parts) {
    if (part === '') {
      return null;
    }
    let part_value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      part_value = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      part_value = Number.parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      part_value = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isSafeInteger(part_value) || part_value < 0) {
      return null;
    }
    part_values.push(part_value);
  }

  // Les formes courtes : la derniere composante couvre les octets restants.
  const last_value: number = part_values[part_values.length - 1]!;
  const leading_values: readonly number[] = part_values.slice(0, -1);
  if (leading_values.some((value: number): boolean => value > 255)) {
    return null;
  }
  const remaining_octets: number = 4 - leading_values.length;
  if (last_value >= 2 ** (8 * remaining_octets)) {
    return null;
  }

  let address_as_integer: number = last_value;
  leading_values.forEach((value: number, index: number): void => {
    address_as_integer += value * 2 ** (8 * (3 - index));
  });
  return address_as_integer;
}

// Developpe une IPv6 abregee en ses huit groupes de 16 bits.
function expand_ipv6_groups(address: string): readonly number[] | null {
  const double_colon_parts: readonly string[] = address.split('::');
  if (double_colon_parts.length > 2) {
    return null;
  }

  const to_groups = (part: string): readonly string[] =>
    part === '' ? [] : part.split(':');

  const head_groups: readonly string[] = to_groups(double_colon_parts[0]!);
  const tail_groups: readonly string[] =
    double_colon_parts.length === 2 ? to_groups(double_colon_parts[1]!) : [];

  const missing_group_count: number =
    double_colon_parts.length === 2 ? 8 - head_groups.length - tail_groups.length : 0;
  if (missing_group_count < 0) {
    return null;
  }

  const written_groups: readonly string[] = [
    ...head_groups,
    ...Array.from({ length: missing_group_count }, (): string => '0'),
    ...tail_groups,
  ];
  if (written_groups.length !== 8) {
    return null;
  }

  const groups: number[] = [];
  for (const written_group of written_groups) {
    if (!/^[0-9a-f]{1,4}$/.test(written_group)) {
      return null;
    }
    groups.push(Number.parseInt(written_group, 16));
  }
  return groups;
}

function targets_loopback_host(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    // La forme de l'URL est deja controlee ailleurs : une valeur illisible ici
    // ne doit pas produire une seconde violation.
    return false;
  }

  // `localhost.` avec le point final absolu designe le meme hote.
  const hostname_without_trailing_dot: string = hostname.replace(/\.$/, '');
  if (LOOPBACK_HOSTNAMES.includes(hostname_without_trailing_dot)) {
    return true;
  }

  // Formes entre crochets. `new URL()` canonicalise l'IPv6 : `[::ffff:127.0.0.1]`
  // devient `[::ffff:7f00:1]`, donc une comparaison sur l'ecriture d'origine ne
  // verrait rien. On decide sur les groupes, pas sur la chaine.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const groups: readonly number[] | null = expand_ipv6_groups(hostname.slice(1, -1));
    if (groups === null) {
      return false;
    }

    const is_all_zero_prefix: boolean = groups
      .slice(0, 5)
      .every((group: number): boolean => group === 0);

    // ::1 (boucle locale) et :: (toutes interfaces).
    if (is_all_zero_prefix && groups[5] === 0) {
      return groups[6] === 0 && (groups[7] === 1 || groups[7] === 0);
    }

    // IPv4 mappee : les 32 derniers bits portent l'adresse IPv4.
    if (is_all_zero_prefix && groups[5] === 0xffff) {
      const mapped_address_as_integer: number = groups[6]! * 2 ** 16 + groups[7]!;
      const first_octet: number = Math.floor(mapped_address_as_integer / 2 ** 24);
      return first_octet === 127 || mapped_address_as_integer === 0;
    }

    return false;
  }

  const address_as_integer: number | null = parse_ipv4_host_as_integer(
    hostname_without_trailing_dot,
  );
  if (address_as_integer === null) {
    return false;
  }

  // 127.0.0.0/8 tout entier, et 0.0.0.0 qui designe « toutes les interfaces ».
  const first_octet: number = Math.floor(address_as_integer / 2 ** 24);
  return first_octet === 127 || address_as_integer === 0;
}

// DATABASE_URL contient le mot de passe Postgres en clair. Il n'etait passe
// qu'au crible de la boucle locale : un POSTGRES_PASSWORD=changeme demarrait en
// production alors que le meme mot de passe sur MINIO_ROOT_PASSWORD etait
// refuse.
function extract_url_password(value: string): string | null {
  try {
    const password: string = new URL(value).password;
    return password === '' ? null : decodeURIComponent(password);
  } catch {
    return null;
  }
}

export const DEFAULT_HTTP_PORT = 3000;

// 9100 et suivants sont la plage conventionnelle des exportateurs Prometheus :
// un operateur qui voit ce port sait ce qu'il regarde sans ouvrir un fichier.
export const DEFAULT_WORKER_METRICS_PORT = 9101;

// Bornes volontairement etroites. En bas : les ports inferieurs a 1024 sont
// privilegies, et le conteneur tourne en uid 1000 — le liage echouerait sur un
// EACCES obscur au demarrage plutot que sur un message de configuration. En
// haut : la borne du protocole. `0` est exclu : il demande un port libre au
// systeme, ce qui n'a de sens que pour un test, jamais pour un service qu'un
// proxy doit joindre a une adresse connue.
export const HTTP_PORT_BOUNDS = { min: 1024, max: 65_535 } as const;

// Lue sans `required_value` : une absence est un choix legitime, pas une
// violation. Une valeur presente, en revanche, est verifiee comme les autres —
// et une valeur illisible est refusee plutot que silencieusement corrigee, sans
// quoi le service ecouterait sur un port choisi par hasard.
function read_optional_port(
  raw_environment: Readonly<Record<string, string | undefined>>,
  variable: string,
  default_port: number,
  violations: EnvironmentViolation[],
): number {
  const raw_port: string | undefined = raw_environment[variable];
  if (raw_port === undefined || raw_port === '') {
    return default_port;
  }

  const parsed_port: number | null = parse_non_negative_integer(raw_port);
  if (
    parsed_port === null ||
    parsed_port < HTTP_PORT_BOUNDS.min ||
    parsed_port > HTTP_PORT_BOUNDS.max
  ) {
    violations.push({ variable, reason: 'malformed' });
    return default_port;
  }

  return parsed_port;
}

const ACCEPTED_PUBLIC_BASE_URL_PROTOCOLS: readonly string[] = ['http:', 'https:'];

// Rend l'URL analysee, ou `null` si la valeur n'est pas une base utilisable :
// mauvais schema, hote absent, ou identifiants embarques — ceux-ci finiraient
// recopies dans les journaux et dans les URLs renvoyees au navigateur.
function parse_public_base_url(value: string): URL | null {
  let parsed_url: URL;
  try {
    parsed_url = new URL(value);
  } catch {
    return null;
  }

  if (!ACCEPTED_PUBLIC_BASE_URL_PROTOCOLS.includes(parsed_url.protocol)) {
    return null;
  }
  if (parsed_url.hostname === '') {
    return null;
  }
  if (parsed_url.username !== '' || parsed_url.password !== '') {
    return null;
  }
  // BetterAuth derive son `basePath` du chemin de cette URL : un chemin non
  // vide deplace TOUTES ses routes et les met en 404. La panne serait totale et
  // muette — l'audit de demarrage annoncerait toujours ses routes ouvertes.
  if (parsed_url.pathname !== '/' || parsed_url.search !== '' || parsed_url.hash !== '') {
    return null;
  }

  return parsed_url;
}

function uses_non_deliverable_email_domain(value: string): boolean {
  const normalized_email: string = value.trim().toLowerCase();
  return NON_DELIVERABLE_EMAIL_DOMAIN_SUFFIXES.some((suffix: string): boolean =>
    normalized_email.endsWith(suffix),
  );
}

export function parse_application_environment(
  raw_environment: Readonly<Record<string, string | undefined>>,
): ApplicationEnvironment {
  const violations: EnvironmentViolation[] = [];

  // Une chaine vide compte comme manquante : une variable presente mais vide
  // n'est configuree qu'en apparence.
  function required_value(variable_name: string): string | undefined {
    const raw_value = raw_environment[variable_name];
    if (raw_value === undefined || raw_value === '') {
      violations.push({ variable: variable_name, reason: 'missing' });
      return undefined;
    }
    return raw_value;
  }

  const node_environment_raw = required_value(
    ENVIRONMENT_VARIABLE_NAMES.node_environment,
  );
  const database_url = required_value(ENVIRONMENT_VARIABLE_NAMES.database_url);
  const access_link_token_pepper = required_value(
    ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper,
  );
  const internal_storage_webhook_secret = required_value(
    ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
  );
  const minio_endpoint = required_value(ENVIRONMENT_VARIABLE_NAMES.minio_endpoint);
  const clamav_endpoint = required_value(ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint);
  const minio_root_user = required_value(ENVIRONMENT_VARIABLE_NAMES.minio_root_user);
  const minio_root_password = required_value(
    ENVIRONMENT_VARIABLE_NAMES.minio_root_password,
  );
  const demo_lawyer_email = required_value(
    ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email,
  );
  const demo_lawyer_password = required_value(
    ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password,
  );
  const trusted_proxy_hop_count_raw = required_value(
    ENVIRONMENT_VARIABLE_NAMES.trusted_proxy_hop_count,
  );
  const public_base_url = required_value(ENVIRONMENT_VARIABLE_NAMES.public_base_url);
  const lawyer_auth_secret = required_value(
    ENVIRONMENT_VARIABLE_NAMES.lawyer_auth_secret,
  );

  // Lu sans `required_value` : une absence est un choix legitime, pas une
  // violation. Une valeur presente, en revanche, est verifiee comme les autres.
  const http_port: number = read_optional_port(
    raw_environment,
    ENVIRONMENT_VARIABLE_NAMES.http_port,
    DEFAULT_HTTP_PORT,
    violations,
  );

  const worker_metrics_port: number = read_optional_port(
    raw_environment,
    ENVIRONMENT_VARIABLE_NAMES.worker_metrics_port,
    DEFAULT_WORKER_METRICS_PORT,
    violations,
  );

  // Deux processus sur la meme machine : un travailleur qui ecouterait sur le
  // port de l'API ne demarrerait pas, et l'erreur serait un EADDRINUSE sans
  // rapport apparent avec la configuration.
  if (worker_metrics_port === http_port) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.worker_metrics_port,
      reason: 'malformed',
    });
  }

  let trusted_proxy_hop_count: number | undefined;
  if (trusted_proxy_hop_count_raw !== undefined) {
    const parsed_hop_count: number | null = parse_non_negative_integer(
      trusted_proxy_hop_count_raw,
    );
    if (parsed_hop_count === null) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.trusted_proxy_hop_count,
        reason: 'malformed',
      });
    } else {
      trusted_proxy_hop_count = parsed_hop_count;
    }
  }

  // On ne verifie la forme d'une variable que si elle est bien presente : une
  // variable manquante n'a pas a produire une seconde violation "malformed".
  let node_environment: NodeEnvironment | undefined;
  if (node_environment_raw !== undefined) {
    if (is_valid_node_environment(node_environment_raw)) {
      node_environment = node_environment_raw;
    } else {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.node_environment,
        reason: 'malformed',
      });
    }
  }

  if (database_url !== undefined && !is_postgres_database_url(database_url)) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.database_url,
      reason: 'malformed',
    });
  }

  if (
    access_link_token_pepper !== undefined &&
    access_link_token_pepper.length < MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper,
      reason: 'malformed',
    });
  }

  if (
    internal_storage_webhook_secret !== undefined &&
    internal_storage_webhook_secret.length <
      MINIMUM_INTERNAL_STORAGE_WEBHOOK_SECRET_LENGTH
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
      reason: 'malformed',
    });
  }

  // Les memes regles que celles appliquees a la creation du compte, appliquees
  // ici au demarrage. Sans cela un DEMO_LAWYER_PASSWORD de quatre caracteres
  // passe le demarrage et n'echoue qu'au moment du seed, loin de sa cause — ce
  // que ce parsing existe precisement pour empecher. La source des bornes est
  // shared/lawyer_credentials.ts, importee ici comme par le module d'auth :
  // deux definitions finiraient par diverger.
  if (demo_lawyer_email !== undefined) {
    const normalized_demo_lawyer_email: string = normalize_lawyer_email(demo_lawyer_email);
    if (
      is_lawyer_email_too_long(normalized_demo_lawyer_email) ||
      !has_lawyer_email_shape(normalized_demo_lawyer_email)
    ) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email,
        reason: 'malformed',
      });
    }
  }

  if (
    demo_lawyer_password !== undefined &&
    find_lawyer_password_length_violation(demo_lawyer_password) !== null
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password,
      reason: 'malformed',
    });
  }

  if (
    lawyer_auth_secret !== undefined &&
    lawyer_auth_secret.length < MINIMUM_LAWYER_AUTH_SECRET_LENGTH
  ) {
    violations.push({
      variable: ENVIRONMENT_VARIABLE_NAMES.lawyer_auth_secret,
      reason: 'malformed',
    });
  }

  let parsed_public_base_url: URL | null = null;
  if (public_base_url !== undefined) {
    parsed_public_base_url = parse_public_base_url(public_base_url);
    if (parsed_public_base_url === null) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.public_base_url,
        reason: 'malformed',
      });
    }
  }

  // Ces controles ne valent qu'en production : les appliquer partout rendrait le
  // poste de developpement inutilisable, ou pousserait a les contourner.
  if (node_environment === 'production') {
    const secrets_to_screen: ReadonlyArray<readonly [string, string | undefined]> = [
      [ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper, access_link_token_pepper],
      [
        ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
        internal_storage_webhook_secret,
      ],
      [ENVIRONMENT_VARIABLE_NAMES.minio_root_user, minio_root_user],
      [ENVIRONMENT_VARIABLE_NAMES.minio_root_password, minio_root_password],
      [ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password, demo_lawyer_password],
      [ENVIRONMENT_VARIABLE_NAMES.lawyer_auth_secret, lawyer_auth_secret],
    ];

    for (const [variable_name, value] of secrets_to_screen) {
      if (value !== undefined && contains_forbidden_production_placeholder(value)) {
        violations.push({
          variable: variable_name,
          reason: 'development_value_in_production',
        });
      }
    }

    const endpoints_to_screen: ReadonlyArray<readonly [string, string | undefined]> = [
      [ENVIRONMENT_VARIABLE_NAMES.database_url, database_url],
      [ENVIRONMENT_VARIABLE_NAMES.minio_endpoint, minio_endpoint],
    ];

    for (const [variable_name, value] of endpoints_to_screen) {
      if (value !== undefined && targets_loopback_host(value)) {
        violations.push({
          variable: variable_name,
          reason: 'development_value_in_production',
        });
      }
    }

    if (database_url !== undefined) {
      const embedded_password: string | null = extract_url_password(database_url);
      if (
        embedded_password !== null &&
        contains_forbidden_production_placeholder(embedded_password)
      ) {
        violations.push({
          variable: ENVIRONMENT_VARIABLE_NAMES.database_url,
          reason: 'development_value_in_production',
        });
      }
    }

    // Le defaut de la bibliotheque ne contient aucun fragment de la liste
    // generique : il se refuse nommement.
    if (lawyer_auth_secret === DEFAULT_BETTER_AUTH_SECRET) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.lawyer_auth_secret,
        reason: 'development_value_in_production',
      });
    }

    // En clair, le cookie de session ne peut pas porter l'attribut `Secure` :
    // il voyagerait lisible sur le reseau, et c'est lui qui vaut identite.
    if (parsed_public_base_url !== null && parsed_public_base_url.protocol !== 'https:') {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.public_base_url,
        reason: 'development_value_in_production',
      });
    }

    if (public_base_url !== undefined && targets_loopback_host(public_base_url)) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.public_base_url,
        reason: 'development_value_in_production',
      });
    }

    if (
      demo_lawyer_email !== undefined &&
      uses_non_deliverable_email_domain(demo_lawyer_email)
    ) {
      violations.push({
        variable: ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email,
        reason: 'development_value_in_production',
      });
    }
  }

  if (violations.length > 0) {
    throw new InvalidEnvironmentError(violations);
  }

  // Aucune assertion de type ici. Un `as string` mentirait au compilateur : le
  // jour ou une variable serait lue sans etre collectee plus haut, il rendrait
  // `undefined` sous un type `string`, et la panne surviendrait loin d'ici.
  // Cette fonction retransforme l'oubli en erreur de demarrage lisible. Le vrai
  // garde-fou reste le test qui parcourt ENVIRONMENT_VARIABLE_NAMES.
  function resolved(variable_name: string, value: string | undefined): string {
    if (value === undefined) {
      throw new InvalidEnvironmentError([{ variable: variable_name, reason: 'missing' }]);
    }
    return value;
  }

  if (node_environment === undefined) {
    throw new InvalidEnvironmentError([
      { variable: ENVIRONMENT_VARIABLE_NAMES.node_environment, reason: 'missing' },
    ]);
  }

  return {
    node_environment,
    database_url: resolved(ENVIRONMENT_VARIABLE_NAMES.database_url, database_url),
    access_link_token_pepper: resolved(
      ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper,
      access_link_token_pepper,
    ),
    internal_storage_webhook_secret: resolved(
      ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret,
      internal_storage_webhook_secret,
    ),
    minio_endpoint: resolved(ENVIRONMENT_VARIABLE_NAMES.minio_endpoint, minio_endpoint),
    clamav_endpoint: resolved(ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint, clamav_endpoint),
    minio_root_user: resolved(ENVIRONMENT_VARIABLE_NAMES.minio_root_user, minio_root_user),
    minio_root_password: resolved(
      ENVIRONMENT_VARIABLE_NAMES.minio_root_password,
      minio_root_password,
    ),
    // Normalise ici et pas seulement a l'ecriture : tout lecteur de cette
    // valeur — journal, compteur d'echecs, comparaison — heriterait sinon de la
    // variante brute, et deux variantes du meme email ouvrent deux compteurs.
    demo_lawyer_email: normalize_lawyer_email(
      resolved(ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email, demo_lawyer_email),
    ),
    demo_lawyer_password: resolved(
      ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password,
      demo_lawyer_password,
    ),
    trusted_proxy_hop_count: trusted_proxy_hop_count ?? 0,
    public_base_url: resolved(
      ENVIRONMENT_VARIABLE_NAMES.public_base_url,
      public_base_url,
    ),
    http_port,
    worker_metrics_port,
    lawyer_auth_secret: resolved(
      ENVIRONMENT_VARIABLE_NAMES.lawyer_auth_secret,
      lawyer_auth_secret,
    ),
  };
}
