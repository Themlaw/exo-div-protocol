import { defineConfig, devices } from '@playwright/test';

// L'origine du FRONT, et le navigateur ne connait qu'elle : Vite mandate /api
// vers le backend, exactement comme Traefik en production. C'est aussi celle que
// `PUBLIC_BASE_URL` doit porter — le lien remis a l'avocat et le CORS du bucket
// MinIO en dependent tous les deux.
const FRONT_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const BACKEND_ORIGIN = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
const WORKER_METRICS_ORIGIN = process.env.E2E_WORKER_URL ?? 'http://127.0.0.1:9101';

// Les trois processus de l'application sont demarres ICI, mais pas leurs
// dependances : Postgres, MinIO et ClamAV viennent du compose de developpement,
// et les lancer aussi ferait de chaque execution un `docker compose up` de
// plusieurs minutes.
const SOURCE_THE_ENVIRONMENT = 'set -a; . ../.env; set +a;';

export default defineConfig({
  testDir: './test/e2e',
  // Charge le `.env` de la racine dans le processus Playwright lui-meme : les
  // scenarios se connectent avec le compte de demonstration amorce a partir de
  // ces memes valeurs.
  globalSetup: './test/e2e/load_root_environment.ts',
  // Un seul travailleur, et des tests qui ne se croisent pas : ils partagent une
  // vraie base, un vrai bucket et un vrai antivirus. Les paralleliser ferait
  // dependre le resultat de l'ordre.
  fullyParallel: false,
  workers: 1,
  // Le scan antiviral d'une piece prend quelques secondes, et le premier
  // demarrage de Nest en prend une dizaine.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: FRONT_ORIGIN,
    trace: 'retain-on-failure',
    // La popup de delivrance propose de copier le message : sans cette
    // permission, Chromium refuse `navigator.clipboard.writeText` et le
    // scenario avocat ne pourrait pas emprunter le chemin normal.
    permissions: ['clipboard-read', 'clipboard-write'],
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: [
    {
      command: `bash -c "${SOURCE_THE_ENVIRONMENT} exec npm run start"`,
      cwd: '../backend',
      url: `${BACKEND_ORIGIN}/health/ready`,
      timeout: 180_000,
      reuseExistingServer: true,
      stdout: 'pipe',
    },
    {
      // Sans le worker, aucun scan ne part : la piece resterait indefiniment
      // « en analyse » et le parcours client ne se terminerait jamais.
      // Playwright considere le 401 de /metrics comme un signe de vie, ce qui
      // evite d'ouvrir une route de sante non authentifiee pour le seul confort
      // des tests.
      command: `bash -c "${SOURCE_THE_ENVIRONMENT} exec npm run start:worker"`,
      cwd: '../backend',
      url: `${WORKER_METRICS_ORIGIN}/metrics`,
      timeout: 180_000,
      reuseExistingServer: true,
      stdout: 'pipe',
    },
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: FRONT_ORIGIN,
      timeout: 120_000,
      reuseExistingServer: true,
    },
  ],
});
