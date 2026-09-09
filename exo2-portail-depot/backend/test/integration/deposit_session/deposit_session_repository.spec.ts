import { eq, sql } from 'drizzle-orm';
import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import { APPLICATION_DATABASE } from '../../../src/db/database.module';
import type { ApplicationDatabase } from '../../../src/db/database_connection';
import { access_link, deposit_session } from '../../../src/db/schema/deposit_schema';
import {
  DEPOSIT_SESSION_REPOSITORY,
  fingerprint_deposit_session_token,
  type DepositSessionRepository,
  type OpenedDepositSession,
} from '../../../src/deposit_session/deposit_session_repository';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../../../src/access_link/access_link_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from '../../../src/deposit/deposit_request_repository';
import type { AccessLink } from '../../../src/domain/access_link';
import {
  is_deposit_session_usable,
  open_client_deposit_session,
} from '../../../src/domain/deposit_session';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';
import { ENVIRONMENT_VARIABLE_NAMES } from '../../../src/config/environment';

const CLEAR_SESSION_TOKEN = 'jeton-de-session-en-clair-de-reference';
const SESSION_LIFETIME_SECONDS = 30 * 60;

describe('Depot des sessions de depot', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let database: ApplicationDatabase;
  let deposit_sessions: DepositSessionRepository;
  let access_links: AccessLinkRepository;
  let deposit_requests: DepositRequestRepository;
  let owner_user_id: string;

  async function issue_link(token_hmac: string): Promise<AccessLink> {
    const deposit_request_id: string = await deposit_requests.create({
      owner_user_id,
      creation: {
        title: 'Dossier de succession',
        expected_documents: [
          {
            label: 'Acte de deces',
            position: 0,
            allowed_mime_types: ['application/pdf'],
            max_size_bytes: 1024,
          },
        ],
      },
      security_policy: DEFAULT_SECURITY_POLICY,
    });

    return (await access_links.issue_link_replacing_current({
      deposit_request_id,
      owner_user_id,
      issuance: {
        token_hmac,
        token_pepper_version: 1,
        pin_hash: 'hachage-opaque',
        security_policy: DEFAULT_SECURITY_POLICY,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      now: new Date(),
    })) as AccessLink;
  }

  // Un jeton distinct par session : l'empreinte est unique en base, et les
  // sessions d'un test survivent au suivant — seul le nettoyage des demandes,
  // fait a l'ouverture de l'application, les emporte.
  async function open_session_on(link: AccessLink): Promise<string> {
    const token = `${CLEAR_SESSION_TOKEN}-${link.id}`;
    await deposit_sessions.open_session({
      session: open_client_deposit_session(link, SESSION_LIFETIME_SECONDS, new Date()),
      token_sha256: fingerprint_deposit_session_token(token),
    });
    return token;
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    const app = integration_test_application.app;
    database = app.get<ApplicationDatabase>(APPLICATION_DATABASE);
    deposit_sessions = app.get<DepositSessionRepository>(DEPOSIT_SESSION_REPOSITORY);
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

  it('retrouve une session par l empreinte de son jeton, AVEC son lien, et rend null pour un jeton inconnu', async () => {
    const link = await issue_link('hmac-session-1');
    const token = await open_session_on(link);

    const found: OpenedDepositSession | null = await deposit_sessions.find_by_token_fingerprint(
      fingerprint_deposit_session_token(token),
    );

    expect(found?.session.access_link_id).toBe(link.id);
    expect(found?.access_link.token_hmac).toBe('hmac-session-1');

    await expect(
      deposit_sessions.find_by_token_fingerprint(
        fingerprint_deposit_session_token('jeton-jamais-emis'),
      ),
    ).resolves.toBeNull();
  });

  it("le jeton en clair n'existe nulle part dans la ligne stockee", async () => {
    const link = await issue_link('hmac-session-sans-clair');
    const token = await open_session_on(link);

    const rows = await database.execute<{ whole_row: string }>(
      sql`SELECT stored_session::text AS whole_row
          FROM deposit.deposit_session AS stored_session
          WHERE stored_session.access_link_id = ${link.id}`,
    );

    expect(rows[0]!.whole_row).not.toContain(token);
  });

  // LA propriete qui justifie de rendre le lien avec la session : l'avocat
  // revoque, et l'appel suivant du client est refuse — sans attendre que la
  // session expire d'elle-meme.
  it("la revocation du lien rend la session inutilisable des l'appel suivant", async () => {
    const link = await issue_link('hmac-session-revoquee');
    const token = await open_session_on(link);

    await access_links.revoke_current_link(link.deposit_request_id, owner_user_id, new Date());

    const found = (await deposit_sessions.find_by_token_fingerprint(
      fingerprint_deposit_session_token(token),
    )) as OpenedDepositSession;

    expect(is_deposit_session_usable(found.session, found.access_link, new Date())).toEqual({
      usable: false,
      rejection_reason: 'access_link_no_longer_usable',
    });
  });

  it('la suppression du lien emporte ses sessions par cascade', async () => {
    const link = await issue_link('hmac-session-cascade');
    const token = await open_session_on(link);

    await database.delete(access_link).where(eq(access_link.id, link.id));

    await expect(
      deposit_sessions.find_by_token_fingerprint(fingerprint_deposit_session_token(token)),
    ).resolves.toBeNull();
  });

  it('la base refuse deux sessions portant la meme empreinte de jeton, et une echeance anterieure a la creation', async () => {
    const link = await issue_link('hmac-session-contraintes');
    const token = await open_session_on(link);

    await expect(
      database.insert(deposit_session).values({
        access_link_id: link.id,
        token_sha256: fingerprint_deposit_session_token(token),
        expires_at: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    await expect(
      database.insert(deposit_session).values({
        access_link_id: link.id,
        token_sha256: fingerprint_deposit_session_token(`autre-${token}`),
        expires_at: new Date(Date.now() - 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
