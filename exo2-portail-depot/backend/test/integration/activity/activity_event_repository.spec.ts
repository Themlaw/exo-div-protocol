import { eq, sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { activity_event, deposit_request } from '../../../src/db/schema/deposit_schema';
import {
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../../../src/activity/activity_event_repository';
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
  build_activity_event,
  type ActivityEvent,
  type DepositRequestActivitySummary,
} from '../../../src/domain/activity_event';
import type { AccessLink } from '../../../src/domain/access_link';
import type { DepositedFile } from '../../../src/domain/deposited_file';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';

const CLIENT_IP = '203.0.113.42';

interface PreparedDepositRequest {
  deposit_request_id: string;
  expected_document_ids: readonly string[];
  access_link: AccessLink;
}

describe("Journal d'activite", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let activity_events: ActivityEventRepository;
  let deposited_files: DepositedFileRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let owner_user_id: string;
  let issued_link_count = 0;

  async function prepare_deposit_request(): Promise<PreparedDepositRequest> {
    const deposit_request_id: string = await deposit_requests.create({
      owner_user_id,
      creation: {
        title: "Dossier de journal d'activite",
        expected_documents: [
          {
            label: 'Piece 0',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 1024 * 1024,
          },
        ],
      },
      security_policy: DEFAULT_SECURITY_POLICY,
    });

    issued_link_count += 1;
    const access_link = (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: {
        token_hmac: `hmac-activite-${issued_link_count}`,
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

  function days_ago(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    activity_events = app.get<ActivityEventRepository>(ACTIVITY_EVENT_REPOSITORY);
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

  describe('ecriture et relecture', () => {
    it("rend l'evenement tel qu'il est entre, acteur compris", async () => {
      const prepared = await prepare_deposit_request();
      const occurred_at = new Date();

      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'access_link_issued',
          actor: { kind: 'lawyer', user_id: owner_user_id },
          access_link_id: prepared.access_link.id,
          occurred_at,
        }),
      );

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        type: 'access_link_issued',
        actor: { kind: 'lawyer', user_id: owner_user_id },
        access_link_id: prepared.access_link.id,
        deposited_file_id: null,
        client_ip: null,
      });
      expect(journal[0]!.occurred_at.getTime()).toBe(occurred_at.getTime());
    });

    it("rend un acteur client sans compte, et un acteur systeme distinct", async () => {
      const prepared = await prepare_deposit_request();

      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_received',
          actor: { kind: 'client' },
          occurred_at: new Date(),
        }),
      );
      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_scanned_clean',
          actor: { kind: 'system' },
          occurred_at: new Date(Date.now() + 1000),
        }),
      );

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(journal.map((event) => event.actor)).toEqual([
        { kind: 'system' },
        { kind: 'client' },
      ]);
    });

    it('rend le journal du plus recent au plus ancien', async () => {
      const prepared = await prepare_deposit_request();
      const reference = Date.now();

      for (const [offset, type] of [
        [0, 'access_link_issued'],
        [1000, 'deposit_session_opened'],
        [2000, 'deposited_file_received'],
      ] as const) {
        await activity_events.record(
          build_activity_event({
            deposit_request_id: prepared.deposit_request_id,
            type,
            actor: { kind: 'client' },
            occurred_at: new Date(reference + offset),
          }),
        );
      }

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(journal.map((event) => event.type)).toEqual([
        'deposited_file_received',
        'deposit_session_opened',
        'access_link_issued',
      ]);
    });

    it('borne la page a la taille demandee', async () => {
      const prepared = await prepare_deposit_request();
      const reference = Date.now();

      for (let index = 0; index < 5; index += 1) {
        await activity_events.record(
          build_activity_event({
            deposit_request_id: prepared.deposit_request_id,
            type: 'deposited_file_received',
            actor: { kind: 'client' },
            occurred_at: new Date(reference + index * 1000),
          }),
        );
      }

      expect(
        await activity_events.list_for_deposit_request(prepared.deposit_request_id, 2),
      ).toHaveLength(2);
    });

    // L'isolation par demande est la seule frontiere de lecture du journal :
    // sans elle, un avocat lirait l'activite du dossier d'un autre.
    it("ne melange jamais le journal de deux demandes", async () => {
      const first = await prepare_deposit_request();
      const second = await prepare_deposit_request();

      await activity_events.record(
        build_activity_event({
          deposit_request_id: first.deposit_request_id,
          type: 'access_link_revoked',
          actor: { kind: 'lawyer', user_id: owner_user_id },
          occurred_at: new Date(),
        }),
      );

      expect(
        await activity_events.list_for_deposit_request(second.deposit_request_id),
      ).toEqual([]);
    });

    it("rend une liste vide sur un identifiant qui n'est pas un UUID", async () => {
      expect(await activity_events.list_for_deposit_request('pas-un-uuid')).toEqual([]);
    });
  });

  describe('contraintes du moteur', () => {
    // Le JUMEAU, cote base, de la liste blanche du domaine. `build_activity_event`
    // ecarte deja l'adresse ; ce test prouve qu'un appelant qui ecrirait
    // directement, en contournant le domaine, serait refuse par Postgres.
    it("refuse une adresse sur un type qui n'a pas a en porter", async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        database.insert(activity_event).values({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_received',
          actor_kind: 'client',
          client_ip: CLIENT_IP,
          occurred_at: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('accepte une adresse sur une tentative d entree', async () => {
      const prepared = await prepare_deposit_request();

      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'client_pin_rejected',
          actor: { kind: 'client' },
          access_link_id: prepared.access_link.id,
          client_ip: CLIENT_IP,
          occurred_at: new Date(),
        }),
      );

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(journal[0]?.client_ip).toBe(CLIENT_IP);
    });

    it("refuse un evenement client porteur d'un compte", async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        database.insert(activity_event).values({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_received',
          actor_kind: 'client',
          actor_user_id: owner_user_id,
          occurred_at: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('refuse un evenement d avocat sans compte', async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        database.insert(activity_event).values({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_downloaded',
          actor_kind: 'lawyer',
          occurred_at: new Date(),
        }),
      ).rejects.toThrow();
    });
  });

  describe('duree de vie du journal', () => {
    // LA propriete d'un journal d'audit : il survit a ce qu'il documente. Une
    // clef etrangere en cascade sur la piece effacerait l'evenement « piece
    // retiree » en meme temps que la piece.
    it('garde l evenement d une piece apres la suppression de cette piece', async () => {
      const prepared = await prepare_deposit_request();
      const file: DepositedFile = await deposited_files.reserve_upload_slot({
        expected_document_id: prepared.expected_document_ids[0]!,
        access_link_id: prepared.access_link.id,
        object_key: `${prepared.deposit_request_id}/journal/${Math.random()}`,
        display_filename: 'contrat.pdf',
        declared_mime_type: 'application/pdf',
        detected_mime_type: null,
        declared_size_bytes: 2048,
        actual_size_bytes: null,
        status: 'pending_upload',
        created_at: new Date(),
        uploaded_at: null,
        scanned_at: null,
      });

      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_removed',
          actor: { kind: 'client' },
          deposited_file_id: file.id,
          occurred_at: new Date(),
        }),
      );
      await deposited_files.delete_file(file.id);

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        type: 'deposited_file_removed',
        deposited_file_id: file.id,
      });
    });

    // L'autre sens, et c'est voulu : le journal documente une demande, il n'a
    // pas de sens sans elle, et l'effacement d'un dossier emporte sa trace.
    it('disparait avec la demande qu il documente', async () => {
      const prepared = await prepare_deposit_request();
      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'access_link_issued',
          actor: { kind: 'lawyer', user_id: owner_user_id },
          occurred_at: new Date(),
        }),
      );

      await database
        .delete(deposit_request)
        .where(eq(deposit_request.id, prepared.deposit_request_id));

      const remaining = await database
        .select()
        .from(activity_event)
        .where(eq(activity_event.deposit_request_id, prepared.deposit_request_id));

      expect(remaining).toEqual([]);
    });
  });

  // Le point de l'argument `writer` : l'action metier et sa trace tiennent ou
  // tombent ENSEMBLE. Un journal ecrit hors transaction se perd exactement
  // quand il compte — sur la panne.
  describe('ecriture dans la transaction de l appelant', () => {
    it("n'ecrit rien quand la transaction de l'action metier echoue", async () => {
      const prepared = await prepare_deposit_request();

      await expect(
        database.transaction(async (transaction): Promise<void> => {
          await activity_events.record(
            build_activity_event({
              deposit_request_id: prepared.deposit_request_id,
              type: 'access_link_revoked',
              actor: { kind: 'lawyer', user_id: owner_user_id },
              occurred_at: new Date(),
            }),
            transaction,
          );

          throw new Error("l'action metier a echoue apres avoir journalise");
        }),
      ).rejects.toThrow();

      expect(
        await activity_events.list_for_deposit_request(prepared.deposit_request_id),
      ).toEqual([]);
    });

    it("ecrit quand la transaction aboutit", async () => {
      const prepared = await prepare_deposit_request();

      await database.transaction(async (transaction): Promise<void> => {
        await activity_events.record(
          build_activity_event({
            deposit_request_id: prepared.deposit_request_id,
            type: 'access_link_revoked',
            actor: { kind: 'lawyer', user_id: owner_user_id },
            occurred_at: new Date(),
          }),
          transaction,
        );
      });

      expect(
        await activity_events.list_for_deposit_request(prepared.deposit_request_id),
      ).toHaveLength(1);
    });
  });

  describe("purge des adresses", () => {
    it("efface les adresses anciennes, garde l'evenement et les adresses recentes", async () => {
      const prepared = await prepare_deposit_request();

      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'client_pin_rejected',
          actor: { kind: 'client' },
          client_ip: CLIENT_IP,
          occurred_at: days_ago(45),
        }),
      );
      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'client_pin_rejected',
          actor: { kind: 'client' },
          client_ip: CLIENT_IP,
          occurred_at: days_ago(2),
        }),
      );

      const redacted_count: number =
        await activity_events.redact_client_ip_recorded_before(days_ago(30));

      const journal: ActivityEvent[] = await activity_events.list_for_deposit_request(
        prepared.deposit_request_id,
      );

      expect(redacted_count).toBe(1);
      // Les DEUX evenements sont toujours la : seule l'adresse est partie.
      expect(journal).toHaveLength(2);
      expect(journal.map((event) => event.client_ip)).toEqual([CLIENT_IP, null]);
    });

    // Le balayage repasse toutes les quinze minutes : sans idempotence il
    // reecrirait sans fin les memes lignes.
    it('ne reprend pas les lignes deja expurgees', async () => {
      const prepared = await prepare_deposit_request();
      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'access_link_blocked',
          actor: { kind: 'system' },
          client_ip: CLIENT_IP,
          occurred_at: days_ago(45),
        }),
      );

      await activity_events.redact_client_ip_recorded_before(days_ago(30));

      expect(await activity_events.redact_client_ip_recorded_before(days_ago(30))).toBe(0);
    });
  });

  describe('resume pour le tableau de bord', () => {
    it('compte les problemes par demande et les distingue', async () => {
      const prepared = await prepare_deposit_request();
      const reference = Date.now();

      for (const [offset, type] of [
        [0, 'deposited_file_scanned_infected'],
        [1000, 'deposited_file_rejected'],
        [2000, 'deposited_file_rejected'],
        [3000, 'client_pin_rejected'],
        [4000, 'access_link_blocked'],
        [5000, 'unusable_access_link_attempted'],
        [6000, 'deposited_file_received'],
      ] as const) {
        await activity_events.record(
          build_activity_event({
            deposit_request_id: prepared.deposit_request_id,
            type,
            actor: { kind: 'system' },
            occurred_at: new Date(reference + offset),
          }),
        );
      }

      const summaries: Map<string, DepositRequestActivitySummary> =
        await activity_events.summarize_deposit_requests([prepared.deposit_request_id]);

      expect(summaries.get(prepared.deposit_request_id)).toEqual({
        has_problem: true,
        infected_count: 1,
        rejected_count: 2,
        rejected_pin_attempt_count: 1,
        unusable_link_attempt_count: 1,
        was_link_blocked: true,
      });
    });

    // Absente de la table plutot que presente avec des zeros : l'appelant
    // retombe sur son resume vide, et la requete ne rapatrie que ce qui merite
    // d'etre affiche.
    it("n'inscrit pas une demande qui ne s'est jamais mal passee", async () => {
      const prepared = await prepare_deposit_request();
      await activity_events.record(
        build_activity_event({
          deposit_request_id: prepared.deposit_request_id,
          type: 'deposited_file_scanned_clean',
          actor: { kind: 'system' },
          occurred_at: new Date(),
        }),
      );

      const summaries: Map<string, DepositRequestActivitySummary> =
        await activity_events.summarize_deposit_requests([prepared.deposit_request_id]);

      expect(summaries.has(prepared.deposit_request_id)).toBe(false);
    });

    it('rend une table vide sans demande a resumer', async () => {
      expect(await activity_events.summarize_deposit_requests([])).toEqual(new Map());
    });
  });
});
