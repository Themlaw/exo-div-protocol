import { Readable } from 'node:stream';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  build_mutable_test_clock,
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
  type MutableTestClock,
} from '../../helpers/integration_application';
import {
  DEPOSIT_REQUESTS_PATH,
  INTERNAL_STORAGE_EVENTS_PATH,
  INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
  LAWYER_AUTH_ROUTE_PATHS,
  PUBLIC_DEPOSIT_PATH,
  resolve_served_route_path,
} from '../../../src/auth/auth_http_contract';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { activity_event, deposited_file } from '../../../src/db/schema/deposit_schema';
import {
  ACTIVITY_EVENT_TYPES,
  type ActivityEventType,
} from '../../../src/domain/activity_event';
import type { DepositRequestActivitySummary } from '../../../src/domain/activity_event';
import { DEFAULT_SECURITY_POLICY, SECURITY_POLICY_BOUNDS } from '../../../src/domain/security_policy';
import {
  OBJECT_STORAGE,
  QUARANTINE_BUCKET_NAME,
  type ObjectStorage,
} from '../../../src/object_storage/object_storage';
import {
  DEPOSITED_FILE_SCANNER,
  type DepositedFileScanner,
} from '../../../src/scan/scan_deposited_file';
import { run_scan_queue_migrations } from '../../../src/scan/scan_queue_migrations';
import {
  ClamavFileScanner,
  parse_clamav_connection_settings,
} from '../../../src/scan/clamav_scanner';
import type { ScanVerdict } from '../../../src/domain/deposited_file';
import type { ApplicationLogger } from '../../../src/shared/logging/application_logger';

const STORAGE_EVENTS_URL: string = resolve_served_route_path(INTERNAL_STORAGE_EVENTS_PATH);
const DECLARED_MIME_TYPE = 'application/pdf';
const MAXIMUM_DOCUMENT_SIZE_BYTES = 8192;
const CONFRERE_PASSWORD = 'tulipe orage marbre cerise lanterne';

// La signature de test standard de l'EICAR : pas un virus, mais la chaine que
// tous les antivirus s'engagent a signaler. C'est le seul moyen de jouer un
// depot infecte sans manipuler de code malveillant.
const EICAR_TEST_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const SANE_PDF_CONTENT: Buffer = Buffer.from('%PDF-1.7\nun document parfaitement ordinaire\n');
const EICAR_CONTENT: Buffer = Buffer.from(EICAR_TEST_SIGNATURE);
// Les huit octets de signature d'un PNG, suivis de remplissage. Annonces en
// `application/pdf`, ils font le depot dont l'etiquette ment.
const PNG_CONTENT: Buffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x21),
]);

interface ClientUploadTicket {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Record<string, string>;
}

interface ClientExpectedDocumentLine {
  id: string;
  position: number;
}

interface LawyerActivityLine {
  id: string;
  type: ActivityEventType;
}

interface DepositRequestOverviewLine {
  id: string;
  activity_summary: DepositRequestActivitySummary;
}

function silent_logger(): ApplicationLogger {
  const ignore = (): void => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

function extract_token_from_delivered_url(delivered_url: string): string {
  return new URL(delivered_url).pathname.split('/').filter(Boolean).at(-1) as string;
}

function wrong_pin_of_same_length(pin: string): string {
  return pin
    .split('')
    .map((digit: string): string => String((Number(digit) + 1) % 10))
    .join('');
}

describe("Vie entiere d'un dossier, lue dans son seul journal d'activite", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let app: INestApplication;
  let database: ApplicationDatabase;
  let object_storage: ObjectStorage;
  let deposited_file_scanner: DepositedFileScanner;
  let clock: MutableTestClock;
  let lawyer_cookie: string;

  let deposit_request_id: string;
  let current_token: string;
  let current_pin: string;
  let deposit_session_cookie: string;
  let expected_document_ids: readonly string[];
  let clean_deposited_file_id: string;
  let removed_deposited_file_id: string;

  let journal: readonly LawyerActivityLine[];

  // L'horloge de l'application avance a chaque geste : deux evenements de la
  // meme milliseconde rendraient l'ordre du journal indecidable, et c'est
  // precisement l'ordre que l'assertion B epingle.
  function let_a_moment_pass(): void {
    clock.advance_seconds(1);
  }

  async function sign_in_lawyer(email: string, password: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(LAWYER_AUTH_ROUTE_PATHS.sign_in)
      .send({ email, password });

    const session_cookie: string | undefined = response.headers['set-cookie'];
    if (session_cookie === undefined) {
      throw new Error(`connexion avocat impossible : statut ${response.status}`);
    }
    return session_cookie;
  }

  async function read_lawyer_journal(
    read_deposit_request_id: string,
    cookie: string,
  ): Promise<readonly LawyerActivityLine[]> {
    const response = await request(app.getHttpServer())
      .get(`${DEPOSIT_REQUESTS_PATH}/${read_deposit_request_id}/activity`)
      .set('Cookie', cookie)
      .expect(200);

    const page = response.body as { events: readonly LawyerActivityLine[]; has_more: boolean };

    // Une histoire allongee un jour au-dela d'une page ferait disparaitre ses
    // evenements les plus ANCIENS, et le test des douze types echouerait en
    // accusant un type manquant au lieu de la troncature.
    expect(page.has_more).toBe(false);

    return page.events;
  }

  // --- L'histoire, geste par geste ---

  async function l_avocat_cree_la_demande_avec_quatre_emplacements(): Promise<void> {
    const response = await request(app.getHttpServer())
      .post(DEPOSIT_REQUESTS_PATH)
      .set('Cookie', lawyer_cookie)
      .send({
        title: 'Dossier au journal complet',
        // Le plancher des essais autorises, et non le defaut : c'est ce qui
        // rend le blocage atteignable en cinq tentatives plutot que dix.
        security_policy: {
          ...DEFAULT_SECURITY_POLICY,
          max_pin_attempts: SECURITY_POLICY_BOUNDS.max_pin_attempts.min,
        },
        expected_documents: Array.from({ length: 4 }, (_unused, position) => ({
          label: `Piece ${position}`,
          position,
          allowed_mime_types: [DECLARED_MIME_TYPE],
          max_size_bytes: MAXIMUM_DOCUMENT_SIZE_BYTES,
        })),
      })
      .expect(201);

    const created = response.body as {
      id: string;
      access_link: { url: string; pin: string };
    };

    deposit_request_id = created.id;
    current_token = extract_token_from_delivered_url(created.access_link.url);
    current_pin = created.access_link.pin;
  }

  async function le_client_se_trompe_de_pin(): Promise<void> {
    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
      .send({ pin: wrong_pin_of_same_length(current_pin) })
      .expect(401);
    let_a_moment_pass();
  }

  async function le_client_deverrouille_le_lien(): Promise<void> {
    const response = await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
      .send({ pin: current_pin })
      .expect(200);

    const [session_cookie] = response.headers['set-cookie'] as unknown as string[];
    deposit_session_cookie = session_cookie.split(';')[0];
    let_a_moment_pass();
  }

  async function le_client_lit_les_emplacements_attendus(): Promise<void> {
    const response = await request(app.getHttpServer())
      .get(`${PUBLIC_DEPOSIT_PATH}/${current_token}/documents`)
      .set('Cookie', deposit_session_cookie)
      .expect(200);

    expected_document_ids = (
      response.body as { expected_documents: readonly ClientExpectedDocumentLine[] }
    ).expected_documents
      .slice()
      .sort(
        (left: ClientExpectedDocumentLine, right: ClientExpectedDocumentLine): number =>
          left.position - right.position,
      )
      .map((document: ClientExpectedDocumentLine): string => document.id);
  }

  // Le chemin REEL du depot : une autorisation d'ecriture presignee, un POST des
  // octets vers MinIO, puis la notification d'arrivee. Ecrire la ligne a la main
  // testerait un depot que la production ne sait pas produire.
  async function le_client_depose_reellement(
    expected_document_index: number,
    content: Buffer,
  ): Promise<string> {
    const authorized = await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/uploads`)
      .set('Cookie', deposit_session_cookie)
      .send({
        expected_document_id: expected_document_ids[expected_document_index],
        filename: `piece-${expected_document_index}.pdf`,
        // Le type ANNONCE fige le Content-Type de la policy presignee : l'objet
        // est stocke etiquete pdf, quels que soient ses octets.
        mime_type: DECLARED_MIME_TYPE,
        size_bytes: content.byteLength,
      })
      .expect(201);

    const ticket = authorized.body as ClientUploadTicket;

    const form = new FormData();
    for (const [field_name, field_value] of Object.entries(ticket.form_fields)) {
      form.append(field_name, field_value);
    }
    form.append(
      'file',
      new Blob([new Uint8Array(content)], { type: DECLARED_MIME_TYPE }),
    );
    const stored: Response = await fetch(ticket.upload_url, { method: 'POST', body: form });
    expect(stored.status).toBe(204);

    await request(app.getHttpServer())
      .post(STORAGE_EVENTS_URL)
      .set(
        INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
        process.env[ENVIRONMENT_VARIABLE_NAMES.internal_storage_webhook_secret] as string,
      )
      .send({
        Records: [
          {
            s3: {
              bucket: { name: QUARANTINE_BUCKET_NAME },
              object: { key: ticket.form_fields.key, size: content.byteLength },
            },
          },
        ],
      })
      .expect(202);

    let_a_moment_pass();
    return ticket.deposited_file_id;
  }

  async function le_scan_rend_son_verdict(scanned_deposited_file_id: string): Promise<void> {
    await deposited_file_scanner.scan(scanned_deposited_file_id);
    let_a_moment_pass();
  }

  async function le_client_retire_sa_piece(removed_file_id: string): Promise<void> {
    await request(app.getHttpServer())
      .delete(`${PUBLIC_DEPOSIT_PATH}/${current_token}/files/${removed_file_id}`)
      .set('Cookie', deposit_session_cookie)
      .expect(204);
    let_a_moment_pass();
  }

  async function l_avocat_telecharge_la_piece_saine(): Promise<void> {
    await request(app.getHttpServer())
      .get(
        `${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/files/${clean_deposited_file_id}/download`,
      )
      .set('Cookie', lawyer_cookie)
      .expect(200);
    let_a_moment_pass();
  }

  async function l_avocat_revoque_le_lien_courant(): Promise<void> {
    await request(app.getHttpServer())
      .delete(`${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/links/current`)
      .set('Cookie', lawyer_cookie)
      .expect(204);
    let_a_moment_pass();
  }

  async function le_client_reessaie_sur_le_lien_revoque(): Promise<void> {
    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
      .send({ pin: current_pin })
      .expect(401);
    let_a_moment_pass();
  }

  async function l_avocat_regenere_un_lien(): Promise<void> {
    const response = await request(app.getHttpServer())
      .post(`${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/links`)
      .set('Cookie', lawyer_cookie)
      .expect(201);

    const delivery = response.body as { url: string; pin: string };
    current_token = extract_token_from_delivered_url(delivery.url);
    current_pin = delivery.pin;
    let_a_moment_pass();
  }

  async function le_client_epuise_les_essais_du_nouveau_lien(): Promise<void> {
    const wrong_pin: string = wrong_pin_of_same_length(current_pin);
    const max_pin_attempts: number = SECURITY_POLICY_BOUNDS.max_pin_attempts.min;

    for (let attempt = 1; attempt < max_pin_attempts; attempt += 1) {
      await request(app.getHttpServer())
        .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
        .send({ pin: wrong_pin })
        .expect(401);
      let_a_moment_pass();
    }

    // Le dernier echec est celui qui bloque, et il l'annonce.
    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
      .send({ pin: wrong_pin })
      .expect(403);
    let_a_moment_pass();
  }

  async function le_client_insiste_sur_le_lien_bloque(): Promise<void> {
    await request(app.getHttpServer())
      .post(`${PUBLIC_DEPOSIT_PATH}/${current_token}/unlock`)
      .send({ pin: current_pin })
      .expect(403);
    let_a_moment_pass();
  }

  beforeAll(async () => {
    // Sonde clamd AVANT tout : sans lui, chaque verdict tomberait en
    // `scanner_unavailable` et l'echec ne nommerait jamais la vraie cause.
    const clamav_probe: ScanVerdict = await new ClamavFileScanner(
      parse_clamav_connection_settings(
        process.env[ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint] as string,
      ),
    ).scan_stream(Readable.from([SANE_PDF_CONTENT]));

    if (clamav_probe === 'scanner_unavailable') {
      console.warn(
        [
          'clamd est injoignable : ce fichier joue un scan antiviral REEL et va echouer.',
          `Verifiez ${ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint} (valeur courante : ${process.env[ENVIRONMENT_VARIABLE_NAMES.clamav_endpoint]})`,
          'puis lancez `docker compose up clamav` et rejouez ce fichier.',
        ].join(' '),
      );
    }

    // Le webhook d'arrivee enfile un scan : sans le schema de la file, il
    // repondrait 500 sur la premiere notification bien formee.
    await run_scan_queue_migrations(
      process.env[ENVIRONMENT_VARIABLE_NAMES.database_url] as string,
      silent_logger(),
    );

    clock = build_mutable_test_clock(new Date());
    integration_test_application = await create_integration_test_application({ clock });
    app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    object_storage = app.get<ObjectStorage>(OBJECT_STORAGE);
    deposited_file_scanner = app.get<DepositedFileScanner>(DEPOSITED_FILE_SCANNER);

    // Les buckets sont crees au demarrage de l'application de production ; le
    // harnais de test ne lance pas ce cycle de vie.
    await object_storage.ensure_buckets_exist();

    lawyer_cookie = await sign_in_lawyer(
      process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string,
      process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_password] as string,
    );

    await l_avocat_cree_la_demande_avec_quatre_emplacements();
    await le_client_se_trompe_de_pin();
    await le_client_deverrouille_le_lien();
    await le_client_lit_les_emplacements_attendus();

    clean_deposited_file_id = await le_client_depose_reellement(0, SANE_PDF_CONTENT);
    await le_scan_rend_son_verdict(clean_deposited_file_id);

    const infected_deposited_file_id: string = await le_client_depose_reellement(1, EICAR_CONTENT);
    await le_scan_rend_son_verdict(infected_deposited_file_id);

    const mislabelled_deposited_file_id: string = await le_client_depose_reellement(2, PNG_CONTENT);
    await le_scan_rend_son_verdict(mislabelled_deposited_file_id);

    removed_deposited_file_id = await le_client_depose_reellement(3, SANE_PDF_CONTENT);
    await le_client_retire_sa_piece(removed_deposited_file_id);

    await l_avocat_telecharge_la_piece_saine();
    await l_avocat_revoque_le_lien_courant();
    await le_client_reessaie_sur_le_lien_revoque();
    await l_avocat_regenere_un_lien();
    await le_client_epuise_les_essais_du_nouveau_lien();
    await le_client_insiste_sur_le_lien_bloque();

    journal = await read_lawyer_journal(deposit_request_id, lawyer_cookie);
  }, 180_000);

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  // La liste attendue est la CONSTANTE, jamais une copie : un treizieme type
  // ajoute demain fera echouer ce test tant qu'aucun chemin reel ne le produit.
  // Un type qu'aucun chemin n'ecrit est un type mort, et ce fichier est le seul
  // endroit ou cela se voit — chaque spec de service ne connait que les siens.
  it('produit les douze types du domaine, et aucun de plus', () => {
    const produced_types: readonly ActivityEventType[] = journal.map(
      (event: LawyerActivityLine): ActivityEventType => event.type,
    );

    expect(new Set(produced_types)).toEqual(new Set(ACTIVITY_EVENT_TYPES));
  });

  it('rend le journal du plus recent au plus ancien, la derniere insistance en tete', async () => {
    const occurred_at_values: readonly number[] = (
      await request(app.getHttpServer())
        .get(`${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/activity`)
        .set('Cookie', lawyer_cookie)
        .expect(200)
    ).body.events.map((event: { occurred_at: string }): number =>
      new Date(event.occurred_at).getTime(),
    );

    expect(occurred_at_values).toEqual([...occurred_at_values].sort((left, right) => right - left));
    expect(journal[0]!.type).toBe('unusable_access_link_attempted');
  });

  // En BASE, et non dans la reponse HTTP : la route n'expose jamais l'adresse,
  // donc s'y fier ne prouverait rien du tri fait a l'ecriture.
  it("ne garde l'adresse du client que sur les quatre types de tentative d'entree", async () => {
    const rows = await database
      .select({ type: activity_event.type })
      .from(activity_event)
      .where(
        and(
          eq(activity_event.deposit_request_id, deposit_request_id),
          isNotNull(activity_event.client_ip),
        ),
      );

    expect(new Set(rows.map((row): ActivityEventType => row.type))).toEqual(
      new Set<ActivityEventType>([
        'client_pin_rejected',
        'access_link_blocked',
        'unusable_access_link_attempted',
        'deposit_session_opened',
      ]),
    );
  });

  it('resume le dossier tel que la liste des demandes le montre a l avocat', async () => {
    const overviews = (
      await request(app.getHttpServer())
        .get(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', lawyer_cookie)
        .expect(200)
    ).body as readonly DepositRequestOverviewLine[];

    const summarized: DepositRequestOverviewLine | undefined = overviews.find(
      (overview: DepositRequestOverviewLine): boolean => overview.id === deposit_request_id,
    );

    expect(summarized?.activity_summary).toEqual({
      has_problem: true,
      infected_count: 1,
      rejected_count: 1,
      // Un essai manque a la premiere phase, cinq au blocage du lien regenere.
      rejected_pin_attempt_count: 6,
      unusable_link_attempt_count: 2,
      was_link_blocked: true,
    });
  });

  it("laisse un confrere introuvable devant ce journal, et le sien vierge de nos evenements", async () => {
    const confrere_email = `confrere-journal-complet-${Date.now()}@cabinet-exemple.fr`;
    await integration_test_application!.create_lawyer_account({
      email: confrere_email,
      plaintext_password: CONFRERE_PASSWORD,
    });
    const confrere_cookie: string = await sign_in_lawyer(confrere_email, CONFRERE_PASSWORD);

    await request(app.getHttpServer())
      .get(`${DEPOSIT_REQUESTS_PATH}/${deposit_request_id}/activity`)
      .set('Cookie', confrere_cookie)
      .expect(404);

    const confrere_deposit_request_id: string = (
      await request(app.getHttpServer())
        .post(DEPOSIT_REQUESTS_PATH)
        .set('Cookie', confrere_cookie)
        .send({
          title: 'Dossier du confrere',
          security_policy: DEFAULT_SECURITY_POLICY,
          expected_documents: [
            {
              label: 'Acte de deces',
              position: 0,
              allowed_mime_types: [DECLARED_MIME_TYPE],
              max_size_bytes: MAXIMUM_DOCUMENT_SIZE_BYTES,
            },
          ],
        })
        .expect(201)
    ).body.id as string;

    const confrere_journal: readonly LawyerActivityLine[] = await read_lawyer_journal(
      confrere_deposit_request_id,
      confrere_cookie,
    );
    const our_event_ids = new Set(journal.map((event: LawyerActivityLine): string => event.id));

    expect(
      confrere_journal.filter((event: LawyerActivityLine): boolean => our_event_ids.has(event.id)),
    ).toEqual([]);
  });

  // La SEULE verification directe de l'absence de clef etrangere vers la piece :
  // le retrait fait disparaitre la ligne deposee, et le journal doit pourtant
  // continuer a dire qu'elle a existe.
  it('garde la trace du retrait alors que la piece a disparu de la table', async () => {
    const surviving_rows = await database
      .select({ deposited_file_id: activity_event.deposited_file_id })
      .from(activity_event)
      .where(
        and(
          eq(activity_event.deposit_request_id, deposit_request_id),
          eq(activity_event.type, 'deposited_file_removed'),
        ),
      );

    expect(surviving_rows).toEqual([{ deposited_file_id: removed_deposited_file_id }]);

    await expect(
      database
        .select({ id: deposited_file.id })
        .from(deposited_file)
        .where(eq(deposited_file.id, removed_deposited_file_id)),
    ).resolves.toEqual([]);
  });
});
