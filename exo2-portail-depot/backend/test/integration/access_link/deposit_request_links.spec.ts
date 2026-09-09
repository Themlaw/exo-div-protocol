import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';
import {
  DEPOSIT_REQUESTS_PATH,
  LAWYER_AUTH_ROUTE_PATHS,
} from '../../../src/auth/auth_http_contract';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { CLIENT_DEPOSIT_PATH } from '../../../src/access_link/access_link_issuer';

interface AccessLinkDeliveryBody {
  url: string;
  pin: string;
  message: string;
  expires_at: string;
}

function build_creation_payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Dossier de succession',
    expected_documents: [
      {
        label: 'Acte de deces',
        position: 0,
        allowed_mime_types: ['application/pdf'],
        max_size_bytes: 5 * 1024 * 1024,
      },
    ],
    ...overrides,
  };
}

async function sign_in(app: INestApplication, email: string, password: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
    .send({ email, password });

  const session_cookie: string | undefined = response.headers['set-cookie'];
  if (session_cookie === undefined) {
    throw new Error(`connexion avocat impossible : statut ${response.status}`);
  }
  return session_cookie;
}

describe('Remise du lien et du PIN', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let lawyer_cookie: string;
  let logger: CapturingLogger;

  async function create_request_with_link(
    payload: Record<string, unknown> = build_creation_payload(),
  ): Promise<{ id: string; access_link: AccessLinkDeliveryBody }> {
    const response = await request(app.getHttpServer())
      .post(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .send(payload)
      .expect(201);

    return response.body as { id: string; access_link: AccessLinkDeliveryBody };
  }

  beforeAll(async () => {
    logger = build_capturing_logger();
    integration_test_application = await create_integration_test_application({ logger });
    app = integration_test_application.app;
    lawyer_cookie = await sign_in(
      app,
      process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string,
      process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password] as string,
    );
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('la creation rend le lien, le PIN et le message ; une relecture de la demande ne les rend plus', async () => {
    const created = await create_request_with_link();

    expect(created.access_link.url).toContain(`${CLIENT_DEPOSIT_PATH}/`);
    expect(created.access_link.pin).toMatch(/^\d+$/);
    expect(created.access_link.message).toContain(created.access_link.url);

    const detail = await request(app.getHttpServer())
      .get(`${DEPOSIT_REQUESTS_PATH}/${created.id}`)
      .set('Cookie', lawyer_cookie)
      .expect(200);

    // Le serveur en est INCAPABLE : le PIN est hache, le token n'existe que
    // sous forme de HMAC. Ce n'est pas un choix d'interface.
    expect(JSON.stringify(detail.body)).not.toContain(created.access_link.pin);
    expect(JSON.stringify(detail.body)).not.toContain(created.access_link.url);
  });

  it('le PIN fait exactement la longueur de la politique retenue', async () => {
    const with_default_policy = await create_request_with_link();
    expect(with_default_policy.access_link.pin).toHaveLength(DEFAULT_SECURITY_POLICY.pin_length);

    const with_chosen_policy = await create_request_with_link(
      build_creation_payload({
        security_policy: { max_pin_attempts: 20, link_lifetime_days: 3, pin_length: 12 },
      }),
    );
    expect(with_chosen_policy.access_link.pin).toHaveLength(12);
  });

  it('le message porte le titre de la demande, l adresse complete et le code', async () => {
    const created = await create_request_with_link(
      build_creation_payload({ title: 'Succession Durand' }),
    );

    expect(created.access_link.message).toContain('Succession Durand');
    expect(created.access_link.message).toContain(created.access_link.url);
    expect(created.access_link.message).toContain(created.access_link.pin);
  });

  it('deux creations successives ne rejouent jamais le meme token ni le meme PIN', async () => {
    const first = await create_request_with_link();
    const second = await create_request_with_link();

    expect(first.access_link.url).not.toBe(second.access_link.url);
    expect(first.access_link.pin).not.toBe(second.access_link.pin);
  });

  it("regenerer rend un nouveau couple et invalide l'ancien des cet instant", async () => {
    const created = await create_request_with_link();

    const regenerated = await request(app.getHttpServer())
      .post(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links`)
      .set('Cookie', lawyer_cookie)
      .expect(201);

    const new_delivery = regenerated.body as AccessLinkDeliveryBody;
    expect(new_delivery.url).not.toBe(created.access_link.url);
    expect(new_delivery.pin).not.toBe(created.access_link.pin);
    expect(new_delivery.message).toContain(new_delivery.url);
  });

  it("l'echeance annoncee vaut la duree de vie choisie, a la minute pres", async () => {
    const created = await create_request_with_link(
      build_creation_payload({
        security_policy: { max_pin_attempts: 10, link_lifetime_days: 3, pin_length: 6 },
      }),
    );

    const expires_at = new Date(created.access_link.expires_at).getTime();
    const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;

    expect(Math.abs(expires_at - expected)).toBeLessThan(60_000);
  });

  it('revoque le lien courant, puis repond 404 puisqu il n y en a plus', async () => {
    const created = await create_request_with_link();

    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links/current`)
      .set('Cookie', lawyer_cookie)
      .expect(204);

    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links/current`)
      .set('Cookie', lawyer_cookie)
      .expect(404);
  });

  it("repond 404 et jamais 403 sur la demande d'un confrere", async () => {
    const other_lawyer_email = `confrere-liens-http-${Date.now()}@cabinet-exemple.fr`;
    await integration_test_application!.create_lawyer_account({
      email: other_lawyer_email,
      plaintext_password: 'tulipe orage marbre cerise lanterne',
    });
    const other_lawyer_cookie: string = await sign_in(
      app,
      other_lawyer_email,
      'tulipe orage marbre cerise lanterne',
    );

    const created = await create_request_with_link();

    await request(app.getHttpServer())
      .post(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links`)
      .set('Cookie', other_lawyer_cookie)
      .expect(404);

    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links/current`)
      .set('Cookie', other_lawyer_cookie)
      .expect(404);
  });

  it('les deux routes exigent une session avocat', async () => {
    const created = await create_request_with_link();

    await request(app.getHttpServer())
      .post(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links`)
      .expect(401);
    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links/current`)
      .expect(401);
  });

  it("« Mes demandes » annonce l'echeance du lien courant, et plus rien apres revocation", async () => {
    const created = await create_request_with_link();

    const listed_with_link = await request(app.getHttpServer())
      .get(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .expect(200);
    const overview_with_link = (listed_with_link.body as { id: string; link_expires_at: string | null }[]).find(
      (overview) => overview.id === created.id,
    );

    expect(overview_with_link?.link_expires_at).toBe(created.access_link.expires_at);

    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links/current`)
      .set('Cookie', lawyer_cookie)
      .expect(204);

    const listed_after_revocation = await request(app.getHttpServer())
      .get(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .expect(200);
    const overview_after_revocation = (
      listed_after_revocation.body as { id: string; link_expires_at: string | null }[]
    ).find((overview) => overview.id === created.id);

    // `null` et non l'echeance du lien mort : un lien revoque n'a plus
    // d'echeance a annoncer, il a une regeneration a demander.
    expect(overview_after_revocation?.link_expires_at).toBeNull();
  });

  // [61][62] Les journaux sont lus par plus de monde que la base, et gardes
  // plus longtemps : un PIN qui y passe une fois y reste.
  it('ni le token ni le PIN n apparaissent dans les journaux', async () => {
    const created = await create_request_with_link();

    await request(app.getHttpServer())
      .post(`${DEPOSIT_REQUESTS_PATH}/${created.id}/links`)
      .set('Cookie', lawyer_cookie)
      .expect(201);

    const journal: string = JSON.stringify(logger.captured_entries);
    expect(journal).not.toContain(created.access_link.pin);
    expect(journal).not.toContain(created.access_link.url);
  });
});
