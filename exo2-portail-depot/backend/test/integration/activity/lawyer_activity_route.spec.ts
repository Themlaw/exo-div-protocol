import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  DEPOSIT_REQUESTS_PATH,
  LAWYER_AUTH_ROUTE_PATHS,
} from '../../../src/auth/auth_http_contract';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { activity_event } from '../../../src/db/schema/deposit_schema';
import {
  ACTIVITY_EVENT_REPOSITORY,
  ACTIVITY_PAGE_SIZE,
  type ActivityEventRepository,
} from '../../../src/activity/activity_event_repository';
import {
  build_activity_event,
  type ActivityEventType,
} from '../../../src/domain/activity_event';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';

const CLIENT_IP = '203.0.113.42';
const CONFRERE_PASSWORD = 'tulipe orage marbre cerise lanterne';

function build_creation_payload(title: string): Record<string, unknown> {
  return {
    title,
    expected_documents: [
      {
        label: 'Acte de deces',
        position: 0,
        allowed_mime_types: ['application/pdf'],
        max_size_bytes: 1024 * 1024,
      },
    ],
  };
}

async function sign_in_lawyer(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
    .send({ email, password });

  const session_cookie: string | undefined = response.headers['set-cookie'];
  if (session_cookie === undefined) {
    throw new Error(`connexion avocat impossible : statut ${response.status}`);
  }
  return session_cookie;
}

describe("Journal d'activite d'une demande, vu par l'avocat", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let database: ApplicationDatabase;
  let activity_events: ActivityEventRepository;
  let lawyer_cookie: string;
  let owner_user_id: string;

  function activity_path(deposit_request_id: string): string {
    return `${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/activity`;
  }

  async function create_deposit_request(cookie: string, title: string): Promise<string> {
    const creation = await request(app.getHttpServer())
      .post(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', cookie)
      .send(build_creation_payload(title));

    if (creation.status !== 201) {
      throw new Error(`creation de demande impossible : statut ${creation.status}`);
    }
    return creation.body.id as string;
  }

  async function record_client_event(
    deposit_request_id: string,
    type: ActivityEventType,
    occurred_at: Date,
    client_ip: string | null = null,
  ): Promise<void> {
    await activity_events.record(
      build_activity_event({
        deposit_request_id,
        type,
        actor: { kind: 'client' },
        client_ip,
        occurred_at,
      }),
    );
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    activity_events = app.get<ActivityEventRepository>(ACTIVITY_EVENT_REPOSITORY);

    const demo_lawyer_email = process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string;
    lawyer_cookie = await sign_in_lawyer(
      app,
      demo_lawyer_email,
      process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password] as string,
    );

    const owner_rows = await database.execute<{ id: string }>(
      sql`SELECT id FROM auth."user" WHERE lower(email) = ${demo_lawyer_email.toLowerCase()}`,
    );
    owner_user_id = owner_rows[0]!.id;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('rend les evenements du plus recent au plus ancien', async () => {
    const deposit_request_id: string = await create_deposit_request(
      lawyer_cookie,
      'Dossier au journal ordonne',
    );
    const reference: number = Date.now();

    await activity_events.record(
      build_activity_event({
        deposit_request_id,
        type: 'access_link_revoked',
        actor: { kind: 'lawyer', user_id: owner_user_id },
        occurred_at: new Date(reference),
      }),
    );
    await record_client_event(
      deposit_request_id,
      'deposit_session_opened',
      new Date(reference + 1000),
    );
    await record_client_event(
      deposit_request_id,
      'deposited_file_received',
      new Date(reference + 2000),
    );

    const response = await request(app.getHttpServer())
      .get(activity_path(deposit_request_id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(200);
    // La creation de la demande emet DEJA son propre evenement — elle emet le
    // premier lien — et il ferme donc la liste, en plus ancien.
    expect(
      response.body.events.map((event: { type: ActivityEventType }): ActivityEventType => event.type),
    ).toEqual([
      'deposited_file_received',
      'deposit_session_opened',
      'access_link_revoked',
      'access_link_issued',
    ]);
    expect(response.body.has_more).toBe(false);
  });

  // L'adresse reste en base pour l'audit, mais rendue a un navigateur elle
  // finirait dans une capture d'ecran ou un PDF imprime — deux endroits que la
  // purge a trente jours n'atteindra jamais.
  it("ne rend aucune adresse client, alors que la ligne en base en porte une", async () => {
    const deposit_request_id: string = await create_deposit_request(
      lawyer_cookie,
      'Dossier a tentative refusee',
    );
    await record_client_event(deposit_request_id, 'client_pin_rejected', new Date(), CLIENT_IP);

    const stored_rows = await database
      .select({ client_ip: activity_event.client_ip })
      .from(activity_event)
      .where(
        and(
          eq(activity_event.deposit_request_id, deposit_request_id),
          eq(activity_event.type, 'client_pin_rejected'),
        ),
      );

    // Sans cette assertion, le test passerait aussi bien sur une base qui
    // n'aurait jamais enregistre l'adresse : il ne prouverait alors rien.
    expect(stored_rows.map((row): string | null => row.client_ip)).toEqual([CLIENT_IP]);

    const response = await request(app.getHttpServer())
      .get(activity_path(deposit_request_id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(200);
    expect(
      response.body.events.map((event: { type: ActivityEventType }): ActivityEventType => event.type),
    ).toContain('client_pin_rejected');
    expect(JSON.stringify(response.body)).not.toContain(CLIENT_IP);
    expect(JSON.stringify(response.body)).not.toContain('client_ip');
  });

  // Un 404 qui differerait de celui d'un identifiant inconnu ferait de
  // l'identifiant d'une demande un oracle d'existence.
  it("repond a la demande d'un confrere exactement comme a un identifiant inexistant", async () => {
    const confrere_email = `confrere-journal-${Date.now()}@cabinet-exemple.fr`;
    await integration_test_application!.create_lawyer_account({
      email: confrere_email,
      plaintext_password: CONFRERE_PASSWORD,
    });
    const confrere_cookie: string = await sign_in_lawyer(app, confrere_email, CONFRERE_PASSWORD);
    const confrere_deposit_request_id: string = await create_deposit_request(
      confrere_cookie,
      'Dossier du confrere',
    );

    const on_confrere_request = await request(app.getHttpServer())
      .get(activity_path(confrere_deposit_request_id))
      .set('Cookie', lawyer_cookie);

    const on_unknown_request = await request(app.getHttpServer())
      .get(activity_path(randomUUID()))
      .set('Cookie', lawyer_cookie);

    expect(on_confrere_request.status).toBe(404);
    expect(on_confrere_request.status).toBe(on_unknown_request.status);
    expect(on_confrere_request.body).toEqual(on_unknown_request.body);
  });

  it('refuse la lecture du journal sans cookie de session', async () => {
    const deposit_request_id: string = await create_deposit_request(
      lawyer_cookie,
      'Dossier sans session',
    );

    const response = await request(app.getHttpServer()).get(activity_path(deposit_request_id));

    expect(response.status).toBe(401);
  });

  it("plafonne la page a ACTIVITY_PAGE_SIZE et signale qu'il y a une suite", async () => {
    const deposit_request_id: string = await create_deposit_request(
      lawyer_cookie,
      'Dossier au journal charge',
    );
    const reference: number = Date.now();

    for (let index = 0; index < ACTIVITY_PAGE_SIZE + 1; index += 1) {
      await record_client_event(
        deposit_request_id,
        'deposited_file_received',
        new Date(reference + index * 1000),
      );
    }

    const response = await request(app.getHttpServer())
      .get(activity_path(deposit_request_id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(response.body.has_more).toBe(true);
  });
});
