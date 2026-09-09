import request, { type Response } from 'supertest';
import { sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
  type NewDepositedFile,
} from '../../../src/deposited_file/deposited_file_repository';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../../../src/access_link/access_link_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from '../../../src/deposit/deposit_request_repository';
import type { AccessLink } from '../../../src/domain/access_link';
import type { DepositedFile, DepositedFileStatus } from '../../../src/domain/deposited_file';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import {
  INTERNAL_STORAGE_EVENTS_PATH,
  INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
  resolve_served_route_path,
} from '../../../src/auth/auth_http_contract';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
} from '../../../src/object_storage/object_storage';
import { SCAN_DEPOSITED_FILE_TASK } from '../../../src/scan/scan_queue';
import { run_scan_queue_migrations } from '../../../src/scan/scan_queue_migrations';
import type { ApplicationLogger } from '../../../src/shared/logging/application_logger';

const REFERENCE_NOW = new Date('2026-03-12T10:00:00.000Z');
const ANNOUNCED_SIZE_BYTES = 4096;

// Le chemin est resolu par le contrat lui-meme : le webhook est servi hors du
// prefixe versionne, et l'ecrire ici en dur ferait diverger le test le jour ou
// cette exception disparaitrait.
const STORAGE_EVENTS_URL: string = resolve_served_route_path(INTERNAL_STORAGE_EVENTS_PATH);

interface PreparedDepositRequest {
  deposit_request_id: string;
  expected_document_ids: readonly string[];
  access_link: AccessLink;
}

type SendStorageEventBody = (pending: request.Test) => request.Test;

interface QueuedScanJob extends Record<string, unknown> {
  task_identifier: string;
  key: string | null;
}

function build_object_arrival_body(input: {
  bucket: string;
  object_key: string;
  size_bytes: number;
}): object {
  return {
    Records: [
      {
        s3: {
          bucket: { name: input.bucket },
          object: { key: input.object_key, size: input.size_bytes },
        },
      },
    ],
  };
}

function silent_logger(): ApplicationLogger {
  const ignore = (): void => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

describe('Webhook des evenements de stockage', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let deposited_files: DepositedFileRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let owner_user_id: string;
  let webhook_secret: string;
  let issued_link_count = 0;

  async function prepare_deposit_request(
    expected_document_count = 1,
  ): Promise<PreparedDepositRequest> {
    const deposit_request_id: string = await deposit_requests.create({
      owner_user_id,
      creation: {
        title: 'Dossier de succession',
        expected_documents: Array.from(
          { length: expected_document_count },
          (_unused, position) => ({
            label: `Piece ${position}`,
            position,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 1024 * 1024,
          }),
        ),
      },
      security_policy: DEFAULT_SECURITY_POLICY,
    });

    issued_link_count += 1;
    const access_link = (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: {
        token_hmac: `hmac-evenement-stockage-${issued_link_count}`,
        token_pepper_version: 1,
        pin_hash: 'hachage-opaque',
        security_policy: DEFAULT_SECURITY_POLICY,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      now: new Date(),
    })) as AccessLink;

    const detail = await deposit_requests.find_detail_for_owner(deposit_request_id, owner_user_id);

    return {
      deposit_request_id,
      expected_document_ids: (detail?.expected_documents ?? []).map((document) => document.id),
      access_link,
    };
  }

  function build_new_file(
    prepared: PreparedDepositRequest,
    overrides: Partial<NewDepositedFile> & {
      expected_document_index?: number;
    } = {},
  ): NewDepositedFile {
    const { expected_document_index = 0, ...file_overrides } = overrides;
    const status: DepositedFileStatus = file_overrides.status ?? 'pending_upload';

    return {
      expected_document_id: prepared.expected_document_ids[expected_document_index],
      access_link_id: prepared.access_link.id,
      object_key: `${prepared.deposit_request_id}/${expected_document_index}/${Math.random()}`,
      display_filename: 'contrat.pdf',
      declared_mime_type: 'application/pdf',
      detected_mime_type: null,
      declared_size_bytes: 2048,
      actual_size_bytes: null,
      status,
      created_at: REFERENCE_NOW,
      uploaded_at: status === 'pending_upload' ? null : REFERENCE_NOW,
      scanned_at: status === 'clean' || status === 'infected' ? REFERENCE_NOW : null,
      ...file_overrides,
    };
  }

  async function reserve_pending_upload_file(): Promise<DepositedFile> {
    const prepared = await prepare_deposit_request();
    return deposited_files.reserve_upload_slot(build_new_file(prepared));
  }

  function pending_storage_event(presented_secret?: string): request.Test {
    const pending: request.Test = request(integration_test_application!.app.getHttpServer()).post(
      STORAGE_EVENTS_URL,
    );

    return presented_secret === undefined
      ? pending
      : pending.set(INTERNAL_STORAGE_WEBHOOK_HEADER_NAME, presented_secret);
  }

  function post_storage_event(body: object, presented_secret?: string): request.Test {
    return pending_storage_event(presented_secret).send(body);
  }

  async function read_queued_scan_jobs(): Promise<readonly QueuedScanJob[]> {
    return database.execute<QueuedScanJob>(
      sql`SELECT task_identifier, key
            FROM graphile_worker.jobs
           WHERE task_identifier = ${SCAN_DEPOSITED_FILE_TASK}`,
    );
  }

  beforeAll(async () => {
    // Le schema de la file n'existe pas tant que ses migrations n'ont pas
    // tourne, et l'enfilement passe par sa fonction SQL : sans cela, la route
    // repondrait 500 sur la premiere notification bien formee.
    await run_scan_queue_migrations(
      process.env[ENVIRONMENT_VARIABLE_NAMES.database_url] as string,
      silent_logger(),
    );

    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    deposited_files = app.get<DepositedFileRepository>(DEPOSITED_FILE_REPOSITORY);
    access_links = app.get<AccessLinkRepository>(ACCESS_LINK_REPOSITORY);
    deposit_requests = app.get<DepositRequestRepository>(DEPOSIT_REQUEST_REPOSITORY);
    webhook_secret = process.env[
      ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret
    ] as string;

    const demo_lawyer_email = process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string;
    const owner_rows = await database.execute<{ id: string }>(
      sql`SELECT id FROM auth."user" WHERE lower(email) = ${demo_lawyer_email.toLowerCase()}`,
    );
    owner_user_id = owner_rows[0]!.id;
  });

  beforeEach(async () => {
    // La vue `jobs` n'est pas modifiable : la table privee est le seul endroit
    // ou vider la file entre deux tests.
    await database.execute(sql`DELETE FROM graphile_worker._private_jobs`);
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('refuse une notification sans secret et ne touche pas a la piece annoncee', async () => {
    const reserved: DepositedFile = await reserve_pending_upload_file();

    const response: Response = await post_storage_event(
      build_object_arrival_body({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: reserved.object_key,
        size_bytes: ANNOUNCED_SIZE_BYTES,
      }),
    );

    expect(response.status).toBe(401);
    await expect(deposited_files.find_by_object_key(reserved.object_key)).resolves.toMatchObject({
      status: 'pending_upload',
      uploaded_at: null,
      actual_size_bytes: null,
    });
    await expect(read_queued_scan_jobs()).resolves.toHaveLength(0);
  });

  it('refuse une notification presentant un secret qui n est pas le notre', async () => {
    const reserved: DepositedFile = await reserve_pending_upload_file();

    const response: Response = await post_storage_event(
      build_object_arrival_body({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: reserved.object_key,
        size_bytes: ANNOUNCED_SIZE_BYTES,
      }),
      'un-secret-qui-n-est-pas-le-notre',
    );

    expect(response.status).toBe(401);
    await expect(deposited_files.find_by_object_key(reserved.object_key)).resolves.toMatchObject({
      status: 'pending_upload',
    });
    await expect(read_queued_scan_jobs()).resolves.toHaveLength(0);
  });

  it('enregistre l arrivee de l objet et enfile son scan', async () => {
    const reserved: DepositedFile = await reserve_pending_upload_file();

    const response: Response = await post_storage_event(
      build_object_arrival_body({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: reserved.object_key,
        size_bytes: ANNOUNCED_SIZE_BYTES,
      }),
      webhook_secret,
    );

    expect(response.status).toBe(202);

    const file_after_arrival: DepositedFile | null = await deposited_files.find_by_object_key(
      reserved.object_key,
    );
    expect(file_after_arrival).toMatchObject({
      status: 'pending_scan',
      actual_size_bytes: ANNOUNCED_SIZE_BYTES,
      scanned_at: null,
    });
    expect(file_after_arrival?.uploaded_at).toBeInstanceOf(Date);

    await expect(read_queued_scan_jobs()).resolves.toEqual([
      {
        task_identifier: SCAN_DEPOSITED_FILE_TASK,
        key: `${SCAN_DEPOSITED_FILE_TASK}:${reserved.id}`,
      },
    ]);
  });

  it('n enfile qu un seul scan quand MinIO reessaie la meme notification', async () => {
    const reserved: DepositedFile = await reserve_pending_upload_file();
    const body: object = build_object_arrival_body({
      bucket: QUARANTINE_BUCKET_NAME,
      object_key: reserved.object_key,
      size_bytes: ANNOUNCED_SIZE_BYTES,
    });

    await expect(post_storage_event(body, webhook_secret)).resolves.toMatchObject({ status: 202 });
    await expect(post_storage_event(body, webhook_secret)).resolves.toMatchObject({ status: 202 });

    await expect(read_queued_scan_jobs()).resolves.toHaveLength(1);
  });

  it('ignore une notification venue d un bucket autre que la quarantaine', async () => {
    const reserved: DepositedFile = await reserve_pending_upload_file();

    const response: Response = await post_storage_event(
      build_object_arrival_body({
        bucket: VERIFIED_BUCKET_NAME,
        object_key: reserved.object_key,
        size_bytes: ANNOUNCED_SIZE_BYTES,
      }),
      webhook_secret,
    );

    expect(response.status).toBe(202);
    await expect(deposited_files.find_by_object_key(reserved.object_key)).resolves.toMatchObject({
      status: 'pending_upload',
      uploaded_at: null,
      actual_size_bytes: null,
    });
    await expect(read_queued_scan_jobs()).resolves.toHaveLength(0);
  });

  // MinIO reessaie indefiniment sur echec : un corps qu'on ne saura jamais lire
  // doit etre accepte, sinon il revient pour toujours.
  it.each<[string, SendStorageEventBody]>([
    [
      'un corps qui n est pas un objet',
      (pending: request.Test): request.Test =>
        pending.type('text/plain').send('ceci n est pas une notification'),
    ],
    [
      'un corps sans Records',
      (pending: request.Test): request.Test => pending.send({ Message: 'coucou' }),
    ],
    [
      'un Records qui n est pas un tableau',
      (pending: request.Test): request.Test => pending.send({ Records: { s3: {} } }),
    ],
    [
      'un enregistrement malforme',
      (pending: request.Test): request.Test =>
        pending.send({
          Records: [{ s3: { bucket: {}, object: { key: 12 } } }],
        }),
    ],
  ])('accepte sans rien ecrire %s', async (_description: string, send: SendStorageEventBody) => {
    const reserved: DepositedFile = await reserve_pending_upload_file();

    const response: Response = await send(pending_storage_event(webhook_secret));

    expect(response.status).toBe(202);
    await expect(deposited_files.find_by_object_key(reserved.object_key)).resolves.toMatchObject({
      status: 'pending_upload',
    });
    await expect(read_queued_scan_jobs()).resolves.toHaveLength(0);
  });

  it('accepte une notification dont la cle n appartient a aucune piece', async () => {
    const response: Response = await post_storage_event(
      build_object_arrival_body({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: 'aucune-piece/ne-porte/cette-cle',
        size_bytes: ANNOUNCED_SIZE_BYTES,
      }),
      webhook_secret,
    );

    expect(response.status).toBe(202);
    await expect(read_queued_scan_jobs()).resolves.toHaveLength(0);
  });
});
