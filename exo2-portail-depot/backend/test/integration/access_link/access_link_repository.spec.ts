import { eq, sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { access_link, deposit_request } from '../../../src/db/schema/deposit_schema';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkIssuance,
  type AccessLinkRepository,
} from '../../../src/access_link/access_link_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from '../../../src/deposit/deposit_request_repository';
import type { AccessLink } from '../../../src/domain/access_link';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';
import { AccessLinkTokenHmacHasher } from '../../../src/access_link/access_link_token_hasher';
import { Argon2idClientPinHasher } from '../../../src/access_link/client_pin_hasher';

const CLEAR_PIN = '482173';
const CLEAR_TOKEN = 'un-token-en-clair-de-reference-1';

function build_issuance(overrides: Partial<AccessLinkIssuance> = {}): AccessLinkIssuance {
  return {
    token_hmac: `hmac-de-${CLEAR_TOKEN}`,
    token_pepper_version: 1,
    pin_hash: `hachage-du-pin-${CLEAR_PIN}`,
    security_policy: DEFAULT_SECURITY_POLICY,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe("Depot des liens d'acces", () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let owner_user_id: string;
  let other_lawyer_user_id: string;

  async function create_deposit_request(for_owner_user_id: string): Promise<string> {
    return deposit_requests.create({
      owner_user_id: for_owner_user_id,
      creation: {
        title: 'Dossier de succession',
        expected_documents: [
          {
            label: 'Acte de deces',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 5 * 1024 * 1024,
          },
        ],
      },
      security_policy: DEFAULT_SECURITY_POLICY,
    });
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    access_links = app.get<AccessLinkRepository>(ACCESS_LINK_REPOSITORY);
    deposit_requests = app.get<DepositRequestRepository>(DEPOSIT_REQUEST_REPOSITORY);

    const demo_lawyer_email = process.env[ENVIRONMENT_VARIABLE_NAMES.demo_lawyer_email] as string;
    const owner_rows = await database.execute<{ id: string }>(
      sql`SELECT id FROM auth."user" WHERE lower(email) = ${demo_lawyer_email.toLowerCase()}`,
    );
    owner_user_id = owner_rows[0]!.id;

    other_lawyer_user_id = await integration_test_application.create_lawyer_account({
      // Email unique par execution : la base est partagee entre les fichiers de
      // test et survit d'une execution a l'autre, seuls les compteurs et les
      // demandes sont remis a zero.
      email: `confrere-liens-${Date.now()}@cabinet-exemple.fr`,
      plaintext_password: 'orage marbre cerise lanterne tulipe',
    });
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  it("retrouve un lien par son empreinte de token, et rend null pour une empreinte inconnue", async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    const issuance = build_issuance();

    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance,
      now: new Date(),
    });

    const found: AccessLink | null = await access_links.find_by_token_hmac(issuance.token_hmac);
    expect(found?.deposit_request_id).toBe(deposit_request_id);
    expect(found?.pin_hash).toBe(issuance.pin_hash);

    await expect(access_links.find_by_token_hmac('empreinte-inconnue')).resolves.toBeNull();
  });

  // Regenerer, c'est invalider : l'ancien couple ne doit plus rien ouvrir, mais
  // la demande et ses pieces survivent.
  it("emettre un nouveau lien revoque l'ancien dans la meme transaction, et la demande survit", async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    const first_issuance = build_issuance({ token_hmac: 'hmac-premier-lien' });
    const second_issuance = build_issuance({ token_hmac: 'hmac-second-lien' });
    const now = new Date();

    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: first_issuance,
      now,
    });
    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: second_issuance,
      now,
    });

    const revoked = await access_links.find_by_token_hmac(first_issuance.token_hmac);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revoked_at).not.toBeNull();

    const current = await access_links.find_by_token_hmac(second_issuance.token_hmac);
    expect(current?.status).toBe('active');

    const surviving_requests = await database
      .select({ id: deposit_request.id })
      .from(deposit_request)
      .where(eq(deposit_request.id, deposit_request_id));
    expect(surviving_requests).toHaveLength(1);
  });

  // La contrainte est dans le moteur, pas dans le code : c'est elle qui tient
  // quand deux emissions se croisent.
  it("la base refuse un second lien actif sur la meme demande", async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: build_issuance({ token_hmac: 'hmac-actif-existant' }),
      now: new Date(),
    });

    await expect(
      database.insert(access_link).values({
        deposit_request_id,
        token_hmac: 'hmac-second-actif',
        token_pepper_version: 1,
        pin_hash: 'peu importe',
        pin_length: DEFAULT_SECURITY_POLICY.pin_length,
        max_pin_attempts: DEFAULT_SECURITY_POLICY.max_pin_attempts,
        expires_at: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it("n'emet ni ne revoque rien sur la demande d'un confrere : l'appartenance est un predicat de requete", async () => {
    const deposit_request_id = await create_deposit_request(other_lawyer_user_id);

    await expect(
      access_links.issue_link_replacing_current({
        deposit_request_id,
        owner_user_id,
        issuance: build_issuance({ token_hmac: 'hmac-vol-de-lien' }),
        now: new Date(),
      }),
    ).resolves.toBeNull();

    await expect(
      access_links.revoke_current_link(deposit_request_id, owner_user_id, new Date()),
    ).resolves.toBe(false);

    await expect(access_links.find_by_token_hmac('hmac-vol-de-lien')).resolves.toBeNull();
  });

  // La verification argon2 se fait HORS transaction : la garde est donc dans la
  // clause WHERE de l'ecriture, jamais dans un verrou tenu pendant le hachage.
  it("ecrit l'issue d'une tentative quand l'etat n'a pas bouge, et refuse d'ecrire quand une autre requete l'a devancee", async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    const issuance = build_issuance({ token_hmac: 'hmac-compteur' });
    const issued = (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance,
      now: new Date(),
    })) as AccessLink;

    await expect(
      access_links.save_attempt_outcome({
        link_after_attempt: { ...issued, failed_pin_attempts: 1 },
        expected_failed_pin_attempts: 0,
      }),
    ).resolves.toBe(true);

    // Une requete concurrente a deja porte le compteur a 1 : la seconde
    // ecriture, qui croit encore partir de 0, ne doit RIEN ecrire.
    await expect(
      access_links.save_attempt_outcome({
        link_after_attempt: { ...issued, failed_pin_attempts: 1 },
        expected_failed_pin_attempts: 0,
      }),
    ).resolves.toBe(false);

    const stored = await access_links.find_by_token_hmac(issuance.token_hmac);
    expect(stored?.failed_pin_attempts).toBe(1);
  });

  it('la base refuse un compteur au-dela du plafond, un statut terminal sans date, et une echeance anterieure a la creation', async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);

    const base_row = {
      deposit_request_id,
      token_pepper_version: 1,
      pin_hash: 'peu importe',
      pin_length: DEFAULT_SECURITY_POLICY.pin_length,
      max_pin_attempts: DEFAULT_SECURITY_POLICY.max_pin_attempts,
      expires_at: new Date(Date.now() + 60_000),
    };

    await expect(
      database.insert(access_link).values({
        ...base_row,
        token_hmac: 'hmac-compteur-hors-bornes',
        status: 'revoked',
        revoked_at: new Date(),
        failed_pin_attempts: DEFAULT_SECURITY_POLICY.max_pin_attempts + 1,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      database.insert(access_link).values({
        ...base_row,
        token_hmac: 'hmac-bloque-sans-date',
        status: 'blocked',
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      database.insert(access_link).values({
        ...base_row,
        token_hmac: 'hmac-echeance-passee',
        status: 'revoked',
        revoked_at: new Date(),
        expires_at: new Date(Date.now() - 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  // Le lien porte SA politique. La demande peut evoluer, un lien deja en
  // circulation ne bouge pas : un client a qui on a promis dix essais ne peut
  // pas se retrouver bloque a cinq.
  it('la politique recopiee sur le lien est independante de celle de la demande', async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    const issuance = build_issuance({
      token_hmac: 'hmac-politique-figee',
      security_policy: { max_pin_attempts: 10, link_lifetime_days: 7, pin_length: 6 },
    });
    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance,
      now: new Date(),
    });

    await database
      .update(deposit_request)
      .set({ max_pin_attempts: 5, pin_length: 4 })
      .where(eq(deposit_request.id, deposit_request_id));

    const link = await access_links.find_by_token_hmac(issuance.token_hmac);
    expect(link?.max_pin_attempts).toBe(10);
    expect(link?.pin_length).toBe(6);
  });

  it("ni le token ni le PIN en clair n'existent en base : seules leurs empreintes y figurent", async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    // Les VRAIS hacheurs, pas des empreintes fictives : ce sont eux qu'on veut
    // prendre en flagrant delit si l'un d'eux laissait passer son entree.
    const token_hasher = new AccessLinkTokenHmacHasher('p'.repeat(64));
    const fingerprint = token_hasher.fingerprint_token(CLEAR_TOKEN);
    const pin_hash: string = await new Argon2idClientPinHasher().hash(CLEAR_PIN);

    const issued = (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: build_issuance({
        token_hmac: fingerprint.token_hmac,
        token_pepper_version: fingerprint.token_pepper_version,
        pin_hash,
      }),
      now: new Date(),
    })) as AccessLink;

    // La ligne entiere, colonne par colonne : chercher seulement dans
    // `token_hmac` et `pin_hash` supposerait de savoir d'avance ou une fuite
    // irait se loger.
    const rows = await database.execute<{ whole_row: string }>(
      sql`SELECT stored_link::text AS whole_row
          FROM deposit.access_link AS stored_link WHERE stored_link.id = ${issued.id}`,
    );

    expect(rows[0]!.whole_row).not.toContain(CLEAR_TOKEN);
    expect(rows[0]!.whole_row).not.toContain(CLEAR_PIN);
  });

  it('revoque le lien courant de sa propre demande, et rend false quand il n y en a plus', async () => {
    const deposit_request_id = await create_deposit_request(owner_user_id);
    const issuance = build_issuance({ token_hmac: 'hmac-a-revoquer' });
    await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance,
      now: new Date(),
    });

    await expect(
      access_links.revoke_current_link(deposit_request_id, owner_user_id, new Date()),
    ).resolves.toBe(true);

    const revoked = await access_links.find_by_token_hmac(issuance.token_hmac);
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revoked_at).not.toBeNull();

    await expect(
      access_links.revoke_current_link(deposit_request_id, owner_user_id, new Date()),
    ).resolves.toBe(false);
  });
});
