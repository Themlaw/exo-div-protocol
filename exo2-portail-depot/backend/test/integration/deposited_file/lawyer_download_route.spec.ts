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
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../../../src/deposited_file/deposited_file_repository';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../../../src/access_link/access_link_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from '../../../src/deposit/deposit_request_repository';
import {
  OBJECT_STORAGE,
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
} from '../../../src/object_storage/object_storage';
import { build_presigned_upload_policy } from '../../../src/domain/presigned_upload';
import type { AccessLink } from '../../../src/domain/access_link';
import type { DepositedFile, DepositedFileStatus } from '../../../src/domain/deposited_file';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';

const DECLARED_MIME_TYPE = 'application/pdf';
const DISPLAY_FILENAME = 'contrat.pdf';
const CONFRERE_PASSWORD = 'tulipe orage marbre cerise lanterne';

interface PreparedDepositRequest {
  deposit_request_id: string;
  expected_document_ids: readonly string[];
  access_link: AccessLink;
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

describe("Telechargement d'une piece par l'avocat", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let database: ApplicationDatabase;
  let deposited_files: DepositedFileRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let object_storage: ObjectStorage;
  let lawyer_cookie: string;
  let owner_user_id: string;
  let issued_link_count = 0;

  function download_path(deposit_request_id: string, deposited_file_id: string): string {
    return `${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/files/${deposited_file_id}/download`;
  }

  async function prepare_deposit_request(
    prepared_owner_user_id: string,
  ): Promise<PreparedDepositRequest> {
    const deposit_request_id: string = await deposit_requests.create({
      owner_user_id: prepared_owner_user_id,
      creation: {
        title: 'Dossier de telechargement',
        expected_documents: [
          {
            label: 'Piece 0',
            position: 0,
            allowed_mime_types: [DECLARED_MIME_TYPE],
            max_size_bytes: 1024 * 1024,
          },
        ],
      },
      security_policy: DEFAULT_SECURITY_POLICY,
    });

    issued_link_count += 1;
    const access_link = (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id: prepared_owner_user_id,
      issuance: {
        token_hmac: `hmac-telechargement-${issued_link_count}`,
        token_pepper_version: 1,
        pin_hash: 'hachage-opaque',
        security_policy: DEFAULT_SECURITY_POLICY,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      now: new Date(),
    })) as AccessLink;

    const detail = await deposit_requests.find_detail_for_owner(
      deposit_request_id,
      prepared_owner_user_id,
    );

    return {
      deposit_request_id,
      expected_document_ids: (detail?.expected_documents ?? []).map((document) => document.id),
      access_link,
    };
  }

  // Le vrai chemin d'ecriture d'un objet, tel que le navigateur du client le
  // suit : une policy signee, puis un POST. Y substituer une ecriture directe
  // stockerait un objet que la production ne sait pas produire.
  async function upload_object_to_quarantine(object_key: string, content: Buffer): Promise<void> {
    const ticket: PresignedUploadTicket = await object_storage.create_presigned_upload(
      build_presigned_upload_policy({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key,
        max_size_bytes: 1024 * 1024,
        expires_at: new Date(Date.now() + 600 * 1000),
      }),
      DECLARED_MIME_TYPE,
    );

    const form = new FormData();
    for (const [field_name, field_value] of Object.entries(ticket.form_fields)) {
      form.append(field_name, field_value);
    }
    form.append('file', new Blob([new Uint8Array(content)], { type: DECLARED_MIME_TYPE }));

    const response: Response = await fetch(ticket.upload_url, { method: 'POST', body: form });
    expect(response.status).toBe(204);
  }

  // Une piece saine EST une piece dont l'objet a ete promu : signer sur la
  // quarantaine viserait un objet qui n'y est plus.
  async function deposit_clean_file(
    prepared: PreparedDepositRequest,
    content: Buffer,
  ): Promise<DepositedFile> {
    const file: DepositedFile = await deposit_file_with_status(
      prepared,
      'clean',
      content.byteLength,
    );
    await upload_object_to_quarantine(file.object_key, content);
    await object_storage.promote_object({
      from_bucket: QUARANTINE_BUCKET_NAME,
      to_bucket: VERIFIED_BUCKET_NAME,
      object_key: file.object_key,
    });

    return file;
  }

  async function deposit_file_with_status(
    prepared: PreparedDepositRequest,
    status: DepositedFileStatus,
    actual_size_bytes: number,
  ): Promise<DepositedFile> {
    const now = new Date();

    return deposited_files.reserve_upload_slot({
      expected_document_id: prepared.expected_document_ids[0]!,
      access_link_id: prepared.access_link.id,
      object_key: `${prepared.deposit_request_id}/telechargement/${randomUUID()}`,
      display_filename: DISPLAY_FILENAME,
      declared_mime_type: DECLARED_MIME_TYPE,
      detected_mime_type: DECLARED_MIME_TYPE,
      declared_size_bytes: actual_size_bytes,
      actual_size_bytes,
      status,
      created_at: now,
      uploaded_at: now,
      scanned_at: now,
    });
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    deposited_files = app.get<DepositedFileRepository>(DEPOSITED_FILE_REPOSITORY);
    access_links = app.get<AccessLinkRepository>(ACCESS_LINK_REPOSITORY);
    deposit_requests = app.get<DepositRequestRepository>(DEPOSIT_REQUEST_REPOSITORY);
    object_storage = app.get<ObjectStorage>(OBJECT_STORAGE);

    // Les buckets sont crees au demarrage de l'application de production ; le
    // harnais de test ne lance pas ce cycle de vie.
    await object_storage.ensure_buckets_exist();

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

  // Le seul test qui prouve la route de bout en bout : une URL bien formee mais
  // signee de travers passerait toutes les assertions de forme et ne rendrait
  // aucun octet.
  it("rend une URL presignee qui ouvre reellement les octets stockes", async () => {
    const prepared = await prepare_deposit_request(owner_user_id);
    const content: Buffer = Buffer.from('les octets exacts de la piece deposee', 'utf8');
    const file: DepositedFile = await deposit_clean_file(prepared, content);

    const response = await request(app.getHttpServer())
      .get(download_path(prepared.deposit_request_id, file.id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(200);
    expect(typeof response.body.download_url).toBe('string');
    expect(new Date(response.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Les en-tetes de protection entrent dans la SIGNATURE, faute de quoi le
    // porteur de l'URL pourrait les retirer.
    expect(response.body.download_url).toContain('response-content-disposition');

    const stored_object: Response = await fetch(response.body.download_url);
    expect(stored_object.status).toBe(200);
    expect(Buffer.from(await stored_object.arrayBuffer()).equals(content)).toBe(true);
  });

  // 409 et non 404 sur SA piece : il en voit deja le statut dans son detail,
  // donc un 404 ne lui cacherait rien — il l'empecherait seulement d'afficher
  // « en quarantaine » plutot que « introuvable ».
  it('refuse par un conflit la piece qui n a pas ete declaree saine', async () => {
    const prepared = await prepare_deposit_request(owner_user_id);
    const infected: DepositedFile = await deposit_file_with_status(prepared, 'infected', 64);

    const response = await request(app.getHttpServer())
      .get(download_path(prepared.deposit_request_id, infected.id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(409);
    expect(response.body.status).toBe('infected');
  });

  // 404 et non 403 : un refus distinct confirmerait l'existence de la piece, et
  // son identifiant deviendrait un oracle pour qui en essaierait.
  it("repond introuvable sur la piece saine d'un confrere", async () => {
    const confrere_email = `confrere-telechargement-${Date.now()}@cabinet-exemple.fr`;
    const confrere_user_id: string = await integration_test_application!.create_lawyer_account({
      email: confrere_email,
      plaintext_password: CONFRERE_PASSWORD,
    });
    const confrere_prepared = await prepare_deposit_request(confrere_user_id);
    const confrere_file: DepositedFile = await deposit_file_with_status(
      confrere_prepared,
      'clean',
      64,
    );

    const response = await request(app.getHttpServer())
      .get(download_path(confrere_prepared.deposit_request_id, confrere_file.id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(404);
  });

  // Le chemin porte la demande ET la piece : sans rapprochement des deux, une
  // piece du dossier A se telechargerait par l'URL du dossier B, et le journal
  // l'inscrirait sous la mauvaise demande.
  it("repond introuvable sur sa propre piece atteinte par l'URL d'une autre demande", async () => {
    const holder = await prepare_deposit_request(owner_user_id);
    const other = await prepare_deposit_request(owner_user_id);
    const own_file: DepositedFile = await deposit_file_with_status(holder, 'clean', 64);

    const response = await request(app.getHttpServer())
      .get(download_path(other.deposit_request_id, own_file.id))
      .set('Cookie', lawyer_cookie);

    expect(response.status).toBe(404);
  });

  // Le telechargement est le seul acces de l'avocat aux octets du client : sans
  // trace, rien ne dirait plus tard qui a sorti la piece du dossier.
  it("inscrit le telechargement au journal de la demande, au nom de l'avocat", async () => {
    const prepared = await prepare_deposit_request(owner_user_id);
    const file: DepositedFile = await deposit_clean_file(prepared, Buffer.alloc(64, 1));

    const response = await request(app.getHttpServer())
      .get(download_path(prepared.deposit_request_id, file.id))
      .set('Cookie', lawyer_cookie);
    expect(response.status).toBe(200);

    const journal_rows = await database
      .select({
        actor_kind: activity_event.actor_kind,
        actor_user_id: activity_event.actor_user_id,
        deposited_file_id: activity_event.deposited_file_id,
      })
      .from(activity_event)
      .where(
        and(
          eq(activity_event.deposit_request_id, prepared.deposit_request_id),
          eq(activity_event.type, 'deposited_file_downloaded'),
        ),
      );

    expect(journal_rows).toEqual([
      {
        actor_kind: 'lawyer',
        actor_user_id: owner_user_id,
        deposited_file_id: file.id,
      },
    ]);
  });
});
