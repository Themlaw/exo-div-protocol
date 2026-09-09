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
  ExpectedDocumentAlreadyOccupiedError,
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

const REFERENCE_NOW = new Date('2026-03-12T10:00:00.000Z');

interface PreparedDepositRequest {
  deposit_request_id: string;
  expected_document_ids: readonly string[];
  access_link: AccessLink;
}

describe('Depot des pieces deposees', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let deposited_files: DepositedFileRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let owner_user_id: string;
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
        token_hmac: `hmac-piece-${issued_link_count}`,
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
    overrides: Partial<NewDepositedFile> & { expected_document_index?: number } = {},
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
      // La contrainte de base lie la date d'arrivee au statut : un objet non
      // arrive n'a pas de date, tout autre statut en a une.
      uploaded_at: status === 'pending_upload' ? null : REFERENCE_NOW,
      // `rejected` est un verdict comme les deux autres : la piece a ete
      // ouverte, son prefixe lu, son type reel detecte.
      scanned_at:
        status === 'clean' || status === 'infected' || status === 'rejected'
          ? REFERENCE_NOW
          : null,
      ...file_overrides,
    };
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    deposited_files = app.get<DepositedFileRepository>(DEPOSITED_FILE_REPOSITORY);
    access_links = app.get<AccessLinkRepository>(ACCESS_LINK_REPOSITORY);
    deposit_requests = app.get<DepositRequestRepository>(DEPOSIT_REQUEST_REPOSITORY);

    const demo_lawyer_email = process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string;
    const owner_rows = await database.execute<{ id: string }>(
      sql`SELECT id FROM auth."user" WHERE lower(email) = ${demo_lawyer_email.toLowerCase()}`,
    );
    owner_user_id = owner_rows[0]!.id;
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it('reserve un emplacement et rend la piece telle que le domaine la voit', async () => {
    const prepared = await prepare_deposit_request();

    const reserved: DepositedFile = await deposited_files.reserve_upload_slot(
      build_new_file(prepared),
    );

    expect(reserved.id).not.toBe('');
    expect(reserved.status).toBe('pending_upload');
    expect(reserved.uploaded_at).toBeNull();
    expect(reserved.expected_document_id).toBe(prepared.expected_document_ids[0]);
  });

  // LA regle du produit : un document attendu, une piece. Elle est tenue par un
  // index unique partiel, donc par Postgres — deux demandes simultanees ne
  // peuvent pas la contourner en lisant toutes deux « libre ».
  it('refuse une seconde piece sur un emplacement deja occupe', async () => {
    const prepared = await prepare_deposit_request();
    await deposited_files.reserve_upload_slot(build_new_file(prepared, { status: 'pending_scan' }));

    await expect(
      deposited_files.reserve_upload_slot(build_new_file(prepared, { status: 'pending_scan' })),
    ).rejects.toBeInstanceOf(ExpectedDocumentAlreadyOccupiedError);
  });

  // Un upload qui n'est jamais arrive ne doit pas condamner l'emplacement :
  // sans quoi une coupure reseau rendrait la piece indeposable pour toujours.
  it('deux reservations en attente d upload cohabitent sur le meme emplacement', async () => {
    const prepared = await prepare_deposit_request();
    await deposited_files.reserve_upload_slot(build_new_file(prepared));

    await expect(
      deposited_files.reserve_upload_slot(build_new_file(prepared)),
    ).resolves.toMatchObject({ status: 'pending_upload' });
  });

  it('un emplacement libere par une suppression redevient reservable', async () => {
    const prepared = await prepare_deposit_request();
    const occupant = await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { status: 'clean' }),
    );

    await deposited_files.delete_file(occupant.id);

    await expect(
      deposited_files.reserve_upload_slot(build_new_file(prepared, { status: 'clean' })),
    ).resolves.toMatchObject({ status: 'clean' });
  });

  it('ne rend pas une piece interrogee au nom d un autre lien', async () => {
    const prepared = await prepare_deposit_request();
    const other = await prepare_deposit_request();
    const reserved = await deposited_files.reserve_upload_slot(build_new_file(prepared));

    await expect(
      deposited_files.find_for_access_link(reserved.id, prepared.access_link.id),
    ).resolves.toMatchObject({ id: reserved.id });

    await expect(
      deposited_files.find_for_access_link(reserved.id, other.access_link.id),
    ).resolves.toBeNull();
  });

  // Un identifiant qui n'est pas un UUID leverait « invalid input syntax » donc
  // un 500, et ce 500 distinguerait cette entree de toutes les autres.
  it('un identifiant qui n est pas un UUID rend null plutot que de lever', async () => {
    const prepared = await prepare_deposit_request();

    await expect(
      deposited_files.find_for_access_link('pas-un-uuid', prepared.access_link.id),
    ).resolves.toBeNull();
  });

  it('liste les pieces de toute une demande, tous emplacements confondus', async () => {
    const prepared = await prepare_deposit_request(2);
    await deposited_files.reserve_upload_slot(build_new_file(prepared, { expected_document_index: 0 }));
    await deposited_files.reserve_upload_slot(build_new_file(prepared, { expected_document_index: 1 }));

    const listed = await deposited_files.list_for_deposit_request(prepared.deposit_request_id);

    expect(listed).toHaveLength(2);
  });

  // Le compteur « 2 pieces sur 4 » du tableau de bord : il ne compte que ce qui
  // occupe reellement, sinon un upload rate ferait croire a l'avocat que le
  // client a depose.
  it('ne compte que les pieces qui occupent vraiment un emplacement', async () => {
    const prepared = await prepare_deposit_request(3);
    await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { expected_document_index: 0, status: 'clean' }),
    );
    await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { expected_document_index: 1, status: 'pending_upload' }),
    );
    await deposited_files.reserve_upload_slot(
      build_new_file(prepared, { expected_document_index: 2, status: 'infected' }),
    );

    const counts = await deposited_files.count_occupied_expected_documents([
      prepared.deposit_request_id,
    ]);

    expect(counts.get(prepared.deposit_request_id)).toBe(1);
  });

  describe('contraintes du moteur', () => {
    // Le cas qui bloquait la file : le scan datait un rejet et Postgres refusait
    // la ligne, donc le travail jetait, donc il etait reessaye — indefiniment.
    // Une piece maquillee immobilisait la file de scan pour toujours.
    it("accepte une piece refusee et datee : le rejet EST un verdict", async () => {
      const prepared = await prepare_deposit_request();

      const rejected: DepositedFile = await deposited_files.reserve_upload_slot(
        build_new_file(prepared, { status: 'rejected' }),
      );

      expect(rejected.scanned_at).toEqual(REFERENCE_NOW);
    });

    it("refuse une piece refusee sans date d'examen", async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        deposited_files.reserve_upload_slot(
          build_new_file(prepared, { status: 'rejected', scanned_at: null }),
        ),
      ).rejects.toThrow();
    });

    // L'autre sens, celui que la contrainte visait depuis le debut : dater ce
    // que PERSONNE n'a ouvert ferait passer pour examine un objet en attente.
    it("refuse une piece en attente de scan qui porterait une date d'examen", async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        deposited_files.reserve_upload_slot(
          build_new_file(prepared, { status: 'pending_scan', scanned_at: REFERENCE_NOW }),
        ),
      ).rejects.toThrow();
    });
  });
});
