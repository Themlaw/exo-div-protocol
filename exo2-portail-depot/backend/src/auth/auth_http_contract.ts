// Les chemins et en-tetes que les tests d'integration doivent connaitre sont
// fixes ici. Laisser chaque test deviner ferait diverger silencieusement le
// test et l'implementation : le test passerait sur une route qui n'existe pas.

// L'API du produit est versionnee des le premier jour, alors meme qu'il n'y a
// qu'une version : ajouter le segment plus tard obligerait a casser tous les
// clients deja installes, ou a servir deux arborescences en parallele. Le
// mettre maintenant ne coute rien.
export const API_ROUTE_PREFIX = '/api/v1';

// Les sondes et le webhook de stockage restent HORS du prefixe versionne : ce
// sont des surfaces d'exploitation, pas l'API du produit. Un passage en v2
// casserait sinon le healthcheck du conteneur et la notification MinIO, pour
// aucun benefice — leur forme, elle, ne bouge pas avec le metier.
export const HEALTH_PATH = '/health';
export const READINESS_PATH = '/health/ready';
export const INTERNAL_STORAGE_EVENTS_PATH = '/internal/storage/events';
export const METRICS_PATH = '/metrics';

export const ROUTES_SERVED_OUTSIDE_THE_VERSIONED_API: readonly string[] = [
  HEALTH_PATH,
  READINESS_PATH,
  INTERNAL_STORAGE_EVENTS_PATH,
];

// Le chemin qu'une route du routeur Nest sert REELLEMENT, prefixe compris. Le
// recensement d'acces et le harnais de test s'en servent : un inventaire qui
// nommerait `/requests` la ou l'application sert `/api/v1/requests` decrirait
// une surface qui n'existe pas.
export function resolve_served_route_path(declared_route_path: string): string {
  return ROUTES_SERVED_OUTSIDE_THE_VERSIONED_API.includes(declared_route_path)
    ? declared_route_path
    : `${API_ROUTE_PREFIX}${declared_route_path}`;
}

// BetterAuth monte ses propres routes. L'enonce suggerait `POST /auth/login` ;
// l'ecart est assume et documente dans le README.
export const LAWYER_AUTH_ROUTE_PATHS = {
  sign_in: `${API_ROUTE_PREFIX}/auth/sign-in/email`,
  sign_out: `${API_ROUTE_PREFIX}/auth/sign-out`,
  session: `${API_ROUTE_PREFIX}/auth/get-session`,
} as const;

export const DEPOSIT_REQUESTS_PATH = `${API_ROUTE_PREFIX}/requests`;

// La surface anonyme du produit. Le cookie de session de depot y est confine :
// il n'accompagne aucune route avocat.
export const PUBLIC_DEPOSIT_PATH = `${API_ROUTE_PREFIX}/public`;
export const DEPOSIT_SESSION_COOKIE_NAME = 'deposit_session';

// Volontairement `/api` et non `/api/v1` : le cookie doit accompagner toutes
// les versions servies, et la restriction utile est ailleurs — le front, servi
// sur le meme domaine, ne recoit plus le cookie de session avec ses assets.
export const LAWYER_SESSION_COOKIE_PATH = '/api';

// MinIO envoie son jeton de notification dans `Authorization`, tel quel et sans
// schema `Bearer` (c'est le comportement de MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN).
// On s'aligne sur l'emetteur : c'est lui qu'on ne peut pas configurer autrement.
export const INTERNAL_STORAGE_WEBHOOK_HEADER_NAME = 'authorization';
