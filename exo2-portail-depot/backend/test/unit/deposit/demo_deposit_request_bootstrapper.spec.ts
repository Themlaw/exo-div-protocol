import { DemoDepositRequestBootstrapper } from '../../../src/deposit/deposit.module';
import type { ApplicationEnvironment } from '../../../src/config/environment';
import type { ApplicationProcessRole } from '../../../src/shared/process_role';
import type { LawyerAccountRepository } from '../../../src/auth/lawyer_account_bootstrap';
import type {
  DemoAccessLinkRepository,
  DemoDepositRequestRepository,
} from '../../../src/deposit/demo_deposit_request_bootstrap';
import type { AccessLinkTokenHasher } from '../../../src/access_link/access_link_token_hasher';
import type { PinHasher } from '../../../src/domain/verify_client_pin';
import type { Clock } from '../../../src/shared/clock';
import { FakeActivityEventRepository } from '../../helpers/fake_activity_event_repository';
import { build_capturing_logger, type CapturingLogger } from '../../helpers/capturing_logger';

const AN_OWNER_USER_ID = 'e0e3f9f2-1a4b-4c3d-8e5f-6a7b8c9d0e1f';
const A_CREATED_DEPOSIT_REQUEST_ID = 'b2c3d4e5-6f70-4182-9394-a5b6c7d8e9f0';
const THE_BOOTSTRAP_INSTANT = new Date('2026-03-01T09:00:00.000Z');

const A_VALID_ENVIRONMENT: ApplicationEnvironment = {
  node_environment: 'production',
  database_url: 'postgres://portail:secret@postgres:5432/portail',
  access_link_token_pepper: 'a'.repeat(32),
  internal_storage_webhook_secret: 'b'.repeat(32),
  minio_endpoint: 'http://minio:9000',
  minio_public_endpoint: undefined,
  clamav_endpoint: 'tcp://clamav:3310',
  minio_root_user: 'portail',
  minio_root_password: 'c'.repeat(16),
  demo_lawyer_email: 'avocat@portail-div.fr',
  demo_lawyer_password: 'atelier balise carnet dossier facade',
  demo_access_link_token: 'aaaabbbbccccddddeeeeffffgggghhhh',
  demo_access_pin: '314159',
  trusted_proxy_hop_count: 1,
  public_base_url: 'https://portail.exemple.fr',
  lawyer_auth_secret: 'd'.repeat(32),
  http_port: 3000,
  worker_metrics_port: 9101,
};

function build_lawyer_accounts(): LawyerAccountRepository {
  return {
    find_id_by_email: async (): Promise<string | null> => AN_OWNER_USER_ID,
    create: async (): Promise<string> => AN_OWNER_USER_ID,
  };
}

function build_token_hasher(): AccessLinkTokenHasher {
  return {
    fingerprint_token: (token: string) => ({
      token_hmac: `hmac(${token})`,
      token_pepper_version: 1,
    }),
  };
}

function build_pin_hasher(): PinHasher {
  return {
    hash: async (pin: string): Promise<string> => `argon2(${pin})`,
    verify: async (pin: string, pin_hash: string): Promise<boolean> =>
      pin_hash === `argon2(${pin})`,
  };
}

// Le depot des liens du deploiement porte une empreinte UNIQUE sur le jeton, et
// le jeton de demonstration est fixe : deux amorcages concurrents se soldent
// necessairement par ce refus-la.
function build_access_link_repository_refusing_a_duplicate(): DemoAccessLinkRepository {
  return {
    issue_link_replacing_current: async (): Promise<never> => {
      throw new Error('duplicate key value violates unique constraint "access_link_token_hmac"');
    },
  };
}

interface CountingDemoDepositRequestRepository extends DemoDepositRequestRepository {
  readonly created_owner_user_ids: readonly string[];
}

function build_deposit_request_repository(): CountingDemoDepositRequestRepository {
  const created_owner_user_ids: string[] = [];

  return {
    created_owner_user_ids,
    count_for_owner: async (): Promise<number> => created_owner_user_ids.length,
    create: async (input): Promise<string> => {
      created_owner_user_ids.push(input.owner_user_id);

      return A_CREATED_DEPOSIT_REQUEST_ID;
    },
  };
}

interface BootstrapperTestContext {
  bootstrapper: DemoDepositRequestBootstrapper;
  deposit_requests: CountingDemoDepositRequestRepository;
  logger: CapturingLogger;
}

function build_bootstrapper_test_context(options: {
  process_role: ApplicationProcessRole;
  access_links?: DemoAccessLinkRepository;
}): BootstrapperTestContext {
  const deposit_requests: CountingDemoDepositRequestRepository =
    build_deposit_request_repository();
  const logger: CapturingLogger = build_capturing_logger();
  const clock: Clock = { now: (): Date => THE_BOOTSTRAP_INSTANT };

  return {
    bootstrapper: new DemoDepositRequestBootstrapper(
      A_VALID_ENVIRONMENT,
      options.process_role,
      build_lawyer_accounts(),
      deposit_requests,
      options.access_links ?? build_access_link_repository_refusing_a_duplicate(),
      build_token_hasher(),
      build_pin_hasher(),
      new FakeActivityEventRepository(),
      clock,
      logger,
    ),
    deposit_requests,
    logger,
  };
}

describe("Amorcage de la demande de demonstration au demarrage d'un processus", () => {
  // Les deux processus montent le meme module et demarrent ensemble sur la meme
  // base. Tant que le travailleur amorcait lui aussi, chacun lisait « l'avocat
  // n'a aucune demande », chacun en creait une, et le second se brisait sur
  // l'empreinte du jeton — fixe par construction.
  it('le travailleur ne seme rien : semer des donnees de demonstration n est pas son metier', async () => {
    const context: BootstrapperTestContext = build_bootstrapper_test_context({
      process_role: 'worker',
    });

    await context.bootstrapper.onApplicationBootstrap();

    expect(context.deposit_requests.created_owner_user_ids).toHaveLength(0);
  });

  it("l'API, elle, seme sur une base vierge", async () => {
    const context: BootstrapperTestContext = build_bootstrapper_test_context({
      process_role: 'api',
    });

    await context.bootstrapper.onApplicationBootstrap();

    expect(context.deposit_requests.created_owner_user_ids).toHaveLength(1);
  });

  // Un amorcage de demonstration qui leve emporte avec lui le demarrage du
  // processus, et donc — dans le travailleur — la file de travaux et tout le
  // scan. Une donnee de demonstration ne vaut pas ce prix-la.
  it("un amorcage qui echoue n'empeche pas le processus de demarrer", async () => {
    const context: BootstrapperTestContext = build_bootstrapper_test_context({
      process_role: 'api',
      access_links: build_access_link_repository_refusing_a_duplicate(),
    });

    await expect(context.bootstrapper.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(
      context.logger.captured_entries.some(
        (entry): boolean =>
          entry.level === 'warn' &&
          entry.message === 'amorcage de la demande de demonstration abandonne',
      ),
    ).toBe(true);
  });
});
