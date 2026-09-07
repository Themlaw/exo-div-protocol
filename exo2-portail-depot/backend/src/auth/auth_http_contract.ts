// Les chemins et en-tetes que les tests d'integration doivent connaitre sont
// fixes ici. Laisser chaque test deviner ferait diverger silencieusement le
// test et l'implementation : le test passerait sur une route qui n'existe pas.

// BetterAuth monte ses propres routes. L'enonce suggerait `POST /auth/login` ;
// l'ecart est assume et documente dans le README.
export const LAWYER_AUTH_ROUTE_PATHS = {
  sign_in: '/api/auth/sign-in/email',
  sign_out: '/api/auth/sign-out',
  session: '/api/auth/get-session',
} as const;

// MinIO envoie son jeton de notification dans `Authorization`, tel quel et sans
// schema `Bearer` (c'est le comportement de MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN).
// On s'aligne sur l'emetteur : c'est lui qu'on ne peut pas configurer autrement.
export const INTERNAL_STORAGE_WEBHOOK_HEADER_NAME = 'authorization';

export const INTERNAL_STORAGE_EVENTS_PATH = '/internal/storage/events';
export const HEALTH_PATH = '/health';
export const READINESS_PATH = '/health/ready';
export const METRICS_PATH = '/metrics';
