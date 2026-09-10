import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  collect_route_access_declarations,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import {
  API_ROUTE_PREFIX,
  INTERNAL_METRICS_SCRAPE_HEADER_NAME,
  INTERNAL_STORAGE_EVENTS_PATH,
  INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
  HEALTH_PATH,
  METRICS_PATH,
  PUBLIC_DEPOSIT_PATH,
} from '../../../src/auth/auth_http_contract';

function read_internal_shared_secret(): string {
  return process.env[ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret] ?? '';
}

// Lit la valeur d'une serie dans le corps d'exposition. Chercher la chaine a la
// main dans chaque test rendrait l'echec muet sur ce qui a ete lu.
function read_series_value(body: string, series: string): number {
  const line: string | undefined = body
    .split('\n')
    .find((candidate: string): boolean => candidate.startsWith(`${series} `));

  if (line === undefined) {
    throw new Error(`serie absente de l'exposition : ${series}`);
  }

  return Number(line.slice(series.length + 1));
}

describe('Routes internes et d observabilite', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  async function scrape_metrics(): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(METRICS_PATH)
      .set(INTERNAL_METRICS_SCRAPE_HEADER_NAME, read_internal_shared_secret());
  }

  it('[4] GET /health repond 200 sans authentification : le healthcheck Docker et la sonde blackbox en dependent', async () => {
    const response = await request(app.getHttpServer()).get(HEALTH_PATH);

    expect(response.status).toBe(200);
  });

  it("[4] GET /health ne divulgue rien d'exploitable dans sa reponse", async () => {
    const response = await request(app.getHttpServer()).get(HEALTH_PATH);

    const raw_response_text = JSON.stringify(response.body ?? {}) + (response.text ?? '');

    // Rien qui ressemble a une chaine de connexion, un identifiant de version
    // de dependance ou un nom d'hote interne ne doit fuiter d'une sonde
    // atteignable sans authentification.
    expect(raw_response_text).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(raw_response_text).not.toMatch(/\d+\.\d+\.\d+/);

    const minio_endpoint = process.env[ENVIRONMENT_VARIABLE_NAMES.minio_endpoint];
    if (minio_endpoint !== undefined && minio_endpoint.length > 0) {
      expect(raw_response_text).not.toContain(minio_endpoint);
    }
  });

  it("[5] GET /metrics sans authentification est refuse : Prometheus l'atteint par le reseau interne, il n'a aucune raison d'etre routee depuis l'exterieur", async () => {
    const response = await request(app.getHttpServer()).get(METRICS_PATH);

    expect(response.status).not.toBe(200);
  });

  it('[5] GET /metrics avec un mauvais secret repond 401, et exactement comme sans secret', async () => {
    const without_secret = await request(app.getHttpServer()).get(METRICS_PATH);
    const with_wrong_secret = await request(app.getHttpServer())
      .get(METRICS_PATH)
      .set(INTERNAL_METRICS_SCRAPE_HEADER_NAME, 'ce-secret-est-faux');

    expect(with_wrong_secret.status).toBe(401);
    expect(with_wrong_secret.status).toBe(without_secret.status);
    expect(with_wrong_secret.body).toEqual(without_secret.body);
  });

  // La forme que Prometheus sait envoyer, et la seule qu'il puisse envoyer :
  // sa configuration impose un schema sur l'en-tete Authorization.
  it("[5] GET /metrics accepte le secret sous la forme `Bearer <secret>`", async () => {
    const response = await request(app.getHttpServer())
      .get(METRICS_PATH)
      .set(INTERNAL_METRICS_SCRAPE_HEADER_NAME, `Bearer ${read_internal_shared_secret()}`);

    expect(response.status).toBe(200);
  });

  it("[6] POST /internal/storage/events accepte lui aussi la forme porteuse", async () => {
    const response = await request(app.getHttpServer())
      .post(INTERNAL_STORAGE_EVENTS_PATH)
      .set(
        INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
        `Bearer ${process.env[ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret] ?? ''}`,
      );

    expect(response.status).not.toBe(401);
  });

  it("[5] GET /metrics avec le bon secret rend l'exposition Prometheus du portail", async () => {
    const response = await scrape_metrics();

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('portail_activity_events_total');
  });

  // La page de metriques est atteignable par un secret partage, donc par plus
  // de monde que la base : y laisser un identifiant de demande ou un jeton en
  // ferait une fuite a cardinalite non bornee autant qu'une fuite tout court.
  it("[5] la page de metriques ne porte aucun identifiant : ses etiquettes sont des enumerations fermees", async () => {
    const response = await scrape_metrics();

    expect(response.text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(response.text).not.toContain('@');
  });

  // 'internal' et non 'health' : une sonde de vie ne dit rien, l'exposition dit
  // la cadence des refus et l'heure du dernier redemarrage.
  it("[5] GET /metrics est declaree avec l'access_kind 'internal'", () => {
    const declarations = collect_route_access_declarations(app);

    const declaration = declarations.find(
      (candidate) => candidate.http_method === 'GET' && candidate.path === METRICS_PATH,
    );

    expect(declaration).toBeDefined();
    expect(declaration?.access_kind).toBe('internal');
  });

  // Hors du prefixe versionne, comme les sondes et le webhook : un passage en
  // v2 casserait sinon la configuration de collecte pour rien.
  it("[5] /metrics n'est pas servie sous le prefixe versionne de l'API", async () => {
    const response = await request(app.getHttpServer())
      .get(`${API_ROUTE_PREFIX}${METRICS_PATH}`)
      .set(INTERNAL_METRICS_SCRAPE_HEADER_NAME, read_internal_shared_secret());

    expect(response.status).not.toBe(200);
  });

  // Le compteur est lu de bout en bout : une tentative reelle sur un jeton
  // inconnu, puis la valeur exposee. Un compteur cable nulle part passerait
  // toutes les autres assertions de ce fichier.
  it("[5] une tentative sur un jeton inconnu fait avancer son compteur", async () => {
    const before: number = read_series_value(
      (await scrape_metrics()).text,
      'portail_unknown_access_link_attempts_total',
    );

    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/jeton-qui-ne-designe-aucune-demande/unlock`)
      .send({ pin: '123456' });

    const after: number = read_series_value(
      (await scrape_metrics()).text,
      'portail_unknown_access_link_attempts_total',
    );

    expect(after).toBe(before + 1);
  });

  it('[6] POST /internal/storage/events sans secret partage repond 401', async () => {
    const response = await request(app.getHttpServer()).post(INTERNAL_STORAGE_EVENTS_PATH);

    expect(response.status).toBe(401);
  });

  it('[6] POST /internal/storage/events avec un mauvais secret repond 401', async () => {
    const response = await request(app.getHttpServer())
      .post(INTERNAL_STORAGE_EVENTS_PATH)
      .set(INTERNAL_STORAGE_WEBHOOK_HEADER_NAME, 'ce-secret-est-faux');

    expect(response.status).toBe(401);
  });

  it("[6] POST /internal/storage/events avec le bon secret n'est plus refuse pour cause d'authentification", async () => {
    const correct_secret = process.env[ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret];

    const response = await request(app.getHttpServer())
      .post(INTERNAL_STORAGE_EVENTS_PATH)
      .set(INTERNAL_STORAGE_WEBHOOK_HEADER_NAME, correct_secret ?? '');

    expect(response.status).not.toBe(401);
  });

  // Confondre « ouvert au client anonyme » et « appele par MinIO avec un
  // secret » ferait qu'un oubli de decorateur sur l'un ouvrirait l'autre :
  // cette route doit porter 'internal', jamais 'client_link'.
  it("[6] POST /internal/storage/events est declare avec l'access_kind 'internal', pas 'client_link'", () => {
    const declarations = collect_route_access_declarations(app);

    const declaration = declarations.find(
      (candidate) =>
        candidate.http_method === 'POST' && candidate.path === INTERNAL_STORAGE_EVENTS_PATH,
    );

    expect(declaration).toBeDefined();
    expect(declaration?.access_kind).toBe('internal');
    expect(declaration?.access_kind).not.toBe('client_link');
  });

  it('[6] la comparaison du secret partage est en temps constant : deux secrets faux de longueurs differentes produisent la meme reponse', async () => {
    const short_wrong_secret = 'a';
    const long_wrong_secret = 'a'.repeat(500);

    const response_with_short_secret = await request(app.getHttpServer())
      .post(INTERNAL_STORAGE_EVENTS_PATH)
      .set(INTERNAL_STORAGE_WEBHOOK_HEADER_NAME, short_wrong_secret);

    const response_with_long_secret = await request(app.getHttpServer())
      .post(INTERNAL_STORAGE_EVENTS_PATH)
      .set(INTERNAL_STORAGE_WEBHOOK_HEADER_NAME, long_wrong_secret);

    expect(response_with_short_secret.status).toBe(response_with_long_secret.status);
    expect(response_with_short_secret.body).toEqual(response_with_long_secret.body);
  });
});
