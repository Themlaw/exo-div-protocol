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
import {
  OBJECT_STORAGE,
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
} from '../../../src/object_storage/object_storage';
import {
  DEPOSIT_RECONCILER,
  UPLOAD_RESERVATION_GRACE_MINUTES,
  type DepositReconciler,
  type ReconciliationReport,
} from '../../../src/scan/reconcile_deposits';
import { run_scan_queue_migrations } from '../../../src/scan/scan_queue_migrations';
import { SCAN_DEPOSITED_FILE_TASK } from '../../../src/scan/scan_queue';
import { build_presigned_upload_policy } from '../../../src/domain/presigned_upload';
import type { AccessLink } from '../../../src/domain/access_link';
import type { DepositedFile, DepositedFileStatus } from '../../../src/domain/deposited_file';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import type { ApplicationLogger } from '../../../src/shared/logging/application_logger';

const DECLARED_MIME_TYPE = 'application/pdf';

interface PreparedDepositRequest {
  deposit_request_id: string;
  expected_document_ids: readonly string[];
  access_link: AccessLink;
}

const silent_logger: ApplicationLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

describe('Reconciliation des depots', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let deposited_files: DepositedFileRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let object_storage: ObjectStorage;
  let reconciler: DepositReconciler;
  let owner_user_id: string;
  let issued_link_count = 0;

  async function prepare_deposit_request(
    expected_document_count = 1,
  ): Promise<PreparedDepositRequest> {
    const deposit_request_id: string = await deposit_requests.create({
      owner_user_id,
      creation: {
        title: 'Dossier de reconciliation',
        expected_documents: Array.from(
          { length: expected_document_count },
          (_unused, position) => ({
            label: `Piece ${position}`,
            position,
            allowed_mime_types: [DECLARED_MIME_TYPE],
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
        token_hmac: `hmac-reconciliation-${issued_link_count}`,
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
    overrides: Partial<NewDepositedFile> = {},
  ): NewDepositedFile {
    const status: DepositedFileStatus = overrides.status ?? 'pending_upload';
    const created_at: Date = overrides.created_at ?? new Date();

    return {
      expected_document_id: prepared.expected_document_ids[0],
      access_link_id: prepared.access_link.id,
      object_key: `${prepared.deposit_request_id}/${prepared.expected_document_ids[0]}/${Math.random()}`,
      display_filename: 'contrat.pdf',
      declared_mime_type: DECLARED_MIME_TYPE,
      detected_mime_type: null,
      declared_size_bytes: 2048,
      actual_size_bytes: null,
      status,
      created_at,
      uploaded_at: status === 'pending_upload' ? null : created_at,
      scanned_at: status === 'clean' || status === 'infected' ? created_at : null,
      ...overrides,
    };
  }

  // Le vrai chemin d'ecriture d'un objet : une policy signee, puis un POST, tel
  // que le navigateur du client le ferait. Y substituer une ecriture directe
  // testerait un objet que la production ne sait pas produire.
  async function upload_object_to_quarantine(
    object_key: string,
    content: Buffer,
  ): Promise<void> {
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

  function minutes_ago(minutes: number): Date {
    return new Date(Date.now() - minutes * 60 * 1000);
  }

  // Le comptage se fait sur la CLE d'unicite, pas sur la charge utile : depuis
  // graphile-worker 0.16 la vue publique `jobs` n'expose plus `payload`, reste
  // dans une table privee qu'un test n'a pas a connaitre. La cle est de toute
  // facon ce dont on veut prouver l'effet.
  async function count_queued_scans_for(deposited_file_id: string): Promise<number> {
    const rows = await database.execute<{ job_count: number }>(
      sql`SELECT count(*)::int AS job_count
            FROM graphile_worker.jobs
           WHERE key = ${`${SCAN_DEPOSITED_FILE_TASK}:${deposited_file_id}`}`,
    );

    return rows[0]?.job_count ?? 0;
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    deposited_files = app.get<DepositedFileRepository>(DEPOSITED_FILE_REPOSITORY);
    access_links = app.get<AccessLinkRepository>(ACCESS_LINK_REPOSITORY);
    deposit_requests = app.get<DepositRequestRepository>(DEPOSIT_REQUEST_REPOSITORY);
    object_storage = app.get<ObjectStorage>(OBJECT_STORAGE);
    reconciler = app.get<DepositReconciler>(DEPOSIT_RECONCILER);

    // La file vit dans son propre schema, que seul le travailleur migre en
    // production : sans cet appel, tout enfilement echouerait ici sur un schema
    // absent.
    await run_scan_queue_migrations(
      process.env[ENVIRONMENT_VARIABLE_NAMES.database_url] as string,
      silent_logger,
    );

    const demo_lawyer_email = process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string;
    const owner_rows = await database.execute<{ id: string }>(
      sql`SELECT id FROM auth."user" WHERE lower(email) = ${demo_lawyer_email.toLowerCase()}`,
    );
    owner_user_id = owner_rows[0]!.id;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  // LA raison d'etre du balayage : la notification de MinIO ne nous est jamais
  // parvenue, et sans lui la piece resterait invisible pour toujours alors que
  // le client l'a bel et bien deposee.
  it('rattrape une piece dont l objet est arrive sans que la notification nous parvienne', async () => {
    const prepared = await prepare_deposit_request();
    const reserved: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared),
    );
    await upload_object_to_quarantine(reserved.object_key, Buffer.alloc(777, 1));

    await reconciler.reconcile();

    const recovered: DepositedFile | null = await deposited_files.find_by_id(reserved.id);
    expect(recovered).toMatchObject({
      status: 'pending_scan',
      // La taille vient de l'objet REELLEMENT stocke, pas de celle que le client
      // avait annoncee a la reservation.
      actual_size_bytes: 777,
      scanned_at: null,
    });
    expect(recovered?.uploaded_at).not.toBeNull();
    expect(await count_queued_scans_for(reserved.id)).toBe(1);
  });

  it('efface une reservation dont le presigned a expire sans qu aucun objet n arrive', async () => {
    const prepared = await prepare_deposit_request();
    const abandoned: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, {
        created_at: minutes_ago(UPLOAD_RESERVATION_GRACE_MINUTES + 1),
      }),
    );

    await reconciler.reconcile();

    expect(await deposited_files.find_by_id(abandoned.id)).toBeNull();
  });

  it('laisse intacte une reservation encore dans sa fenetre de transfert', async () => {
    const prepared = await prepare_deposit_request();
    const in_flight: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, {
        created_at: minutes_ago(UPLOAD_RESERVATION_GRACE_MINUTES - 1),
      }),
    );

    await reconciler.reconcile();

    expect(await deposited_files.find_by_id(in_flight.id)).toMatchObject({
      status: 'pending_upload',
    });
  });

  it('supprime du bucket un objet que plus aucune piece ne reclame', async () => {
    const orphan_object_key = `reconciliation/orphelin/${Date.now()}-${Math.random()}`;
    await upload_object_to_quarantine(orphan_object_key, Buffer.alloc(64, 1));

    await reconciler.reconcile();

    expect(
      await object_storage.describe_object(QUARANTINE_BUCKET_NAME, orphan_object_key),
    ).toBeNull();
  });

  // Sans cette garde, le balayage detruirait exactement les objets que le
  // travailleur s'apprete a lire, et la piece resterait en attente d'un scan
  // devenu impossible.
  it("ne touche pas a l'objet d'une piece qui attend son scan", async () => {
    const prepared = await prepare_deposit_request();
    const waiting: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { status: 'pending_scan', actual_size_bytes: 64 }),
    );
    await upload_object_to_quarantine(waiting.object_key, Buffer.alloc(64, 1));

    await reconciler.reconcile();

    expect(
      await object_storage.describe_object(QUARANTINE_BUCKET_NAME, waiting.object_key),
    ).not.toBeNull();
  });

  // Le reste d'une promotion interrompue : l'objet a ete copie dans le bucket
  // definitif mais sa copie de quarantaine n'a pas ete effacee.
  it('nettoie la copie de quarantaine d une piece deja promue sans toucher a l originale', async () => {
    const prepared = await prepare_deposit_request();
    const promoted: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { status: 'clean', actual_size_bytes: 64 }),
    );
    await upload_object_to_quarantine(promoted.object_key, Buffer.alloc(64, 1));
    await object_storage.promote_object({
      from_bucket: QUARANTINE_BUCKET_NAME,
      to_bucket: VERIFIED_BUCKET_NAME,
      object_key: promoted.object_key,
    });
    await upload_object_to_quarantine(promoted.object_key, Buffer.alloc(64, 1));

    await reconciler.reconcile();

    expect(
      await object_storage.describe_object(QUARANTINE_BUCKET_NAME, promoted.object_key),
    ).toBeNull();
    expect(
      await object_storage.describe_object(VERIFIED_BUCKET_NAME, promoted.object_key),
    ).not.toBeNull();
  });

  it('reenfile le scan d une piece qui l attend depuis trop longtemps', async () => {
    const prepared = await prepare_deposit_request();
    const overdue: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, {
        status: 'pending_scan',
        actual_size_bytes: 64,
        created_at: minutes_ago(120),
      }),
    );
    await upload_object_to_quarantine(overdue.object_key, Buffer.alloc(64, 1));

    const report: ReconciliationReport = await reconciler.reconcile();

    expect(report.overdue_scans_requeued).toBeGreaterThanOrEqual(1);
    // UN SEUL job malgre les passes repetees : c'est la cle d'unicite de la file
    // qui le garantit, et sans elle chaque balayage empilerait un doublon.
    await reconciler.reconcile();
    expect(await count_queued_scans_for(overdue.id)).toBe(1);
  });
});
