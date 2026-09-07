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
  INTERNAL_STORAGE_EVENTS_PATH,
  INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
  HEALTH_PATH,
  METRICS_PATH,
} from '../../../src/auth/auth_http_contract';

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
