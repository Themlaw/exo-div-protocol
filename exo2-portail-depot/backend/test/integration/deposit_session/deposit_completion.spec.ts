import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  DEPOSIT_REQUESTS_PATH,
  LAWYER_AUTH_ROUTE_PATHS,
  PUBLIC_DEPOSIT_PATH,
} from '../../../src/auth/auth_http_contract';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';

const MAXIMUM_DOCUMENT_SIZE_BYTES = 4096;

interface IssuedLink {
  deposit_request_id: string;
  token: string;
  pin: string;
}

interface ClientUploadTicketBody {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Record<string, string>;
}

interface ClientDepositBoardBody {
  deposit_request_status: string;
  expected_documents: readonly { id: string }[];
}

// Le lien remis est une URL de FRONT : le jeton que l'API attend en est le
// dernier segment, et le test le derive comme le fera le navigateur.
function extract_token_from_delivered_url(delivered_url: string): string {
  return new URL(delivered_url).pathname.split('/').filter(Boolean).at(-1) as string;
}

describe('Fin de depot annoncee par le client', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let lawyer_cookie: string;
  let database: ApplicationDatabase;

  async function issue_link(): Promise<IssuedLink> {
    const response = await request(app.getHttpServer())
      .post(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .send({
        title: 'Dossier de succession',
        security_policy: DEFAULT_SECURITY_POLICY,
        expected_documents: [
          {
            label: 'Acte de deces',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: MAXIMUM_DOCUMENT_SIZE_BYTES,
          },
        ],
      })
      .expect(201);

    const created = response.body as { id: string; access_link: { url: string; pin: string } };
    return {
      deposit_request_id: created.id,
      token: extract_token_from_delivered_url(created.access_link.url),
      pin: created.access_link.pin,
    };
  }

  async function unlock_and_keep_cookie(link: IssuedLink): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${link.token}/unlock`)
      .send({ pin: link.pin })
      .expect(200);
    const [session_cookie] = response.headers['set-cookie'] as unknown as string[];
    return session_cookie.split(';')[0];
  }

  function complete_deposit(token: string, session_cookie?: string): request.Test {
    const pending = request(app.getHttpServer()).post(
      `${PUBLIC_DEPOSIT_PATH}/${token}/completion`,
    );
    return session_cookie === undefined ? pending : pending.set('Cookie', session_cookie);
  }

  async function read_first_expected_document_id(
    token: string,
    session_cookie: string,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`${PUBLIC_DEPOSIT_PATH}/${token}/documents`)
      .set('Cookie', session_cookie)
      .expect(200);
    return (response.body as ClientDepositBoardBody).expected_documents[0].id;
  }

  // Ce que fera la notification `s3:ObjectCreated` : la piece occupe desormais
  // l'emplacement. Ecrit a la main plutot que poste dans MinIO — ce test ne
  // parle pas du transfert, mais du gel qui suit la fin du depot.
  async function reserve_and_occupy_slot(
    link: IssuedLink,
    session_cookie: string,
  ): Promise<string> {
    const expected_document_id: string = await read_first_expected_document_id(
      link.token,
      session_cookie,
    );

    const authorized = await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${link.token}/uploads`)
      .set('Cookie', session_cookie)
      .send({
        expected_document_id,
        filename: 'contrat.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
      })
      .expect(201);

    const ticket = authorized.body as ClientUploadTicketBody;
    await database.execute(
      sql`UPDATE deposit.deposited_file
          SET status = 'pending_scan', uploaded_at = now()
          WHERE id = ${ticket.deposited_file_id}::uuid`,
    );
    return ticket.deposited_file_id;
  }

  async function read_status_as_lawyer(deposit_request_id: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}`)
      .set('Cookie', lawyer_cookie)
      .expect(200);
    return (response.body as { status: string }).status;
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);

    const sign_in_response = await request(app.getHttpServer())
      .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
      .send({
        email: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string,
        password: process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password] as string,
      })
      .expect(200);
    lawyer_cookie = sign_in_response.headers['set-cookie'] as unknown as string;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('la fin de depot fait passer la demande en traitement', async () => {
    const link: IssuedLink = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);

    const response = await complete_deposit(link.token, session_cookie).expect(200);

    expect(response.body).toEqual({ status: 'processing' });
  });

  // Terminer deux fois n'est pas une panne : c'est une interface qui a propose
  // une action qu'elle n'aurait pas du proposer, et le client doit le lire.
  it('terminer une seconde fois repond 409', async () => {
    const link: IssuedLink = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);

    await complete_deposit(link.token, session_cookie).expect(200);
    await complete_deposit(link.token, session_cookie).expect(409);
  });

  it('sans session de depot, la fin de depot est refusee', async () => {
    const link: IssuedLink = await issue_link();

    await complete_deposit(link.token).expect(401);

    expect(await read_status_as_lawyer(link.deposit_request_id)).toBe('incomplete');
  });

  // LE gel, et il ne coute aucune ligne de plus : le retrait lit le statut de la
  // demande, et `processing` le lui interdit deja.
  it('une fois le depot termine, le retrait d une piece repond 409', async () => {
    const link: IssuedLink = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);
    const deposited_file_id: string = await reserve_and_occupy_slot(link, session_cookie);

    await complete_deposit(link.token, session_cookie).expect(200);

    await request(app.getHttpServer())
      .delete(`${PUBLIC_DEPOSIT_PATH}/${link.token}/files/${deposited_file_id}`)
      .set('Cookie', session_cookie)
      .expect(409);
  });

  it('l avocat voit la demande passee en traitement dans son detail', async () => {
    const link: IssuedLink = await issue_link();
    const session_cookie: string = await unlock_and_keep_cookie(link);

    expect(await read_status_as_lawyer(link.deposit_request_id)).toBe('incomplete');

    await complete_deposit(link.token, session_cookie).expect(200);

    expect(await read_status_as_lawyer(link.deposit_request_id)).toBe('processing');
  });
});
