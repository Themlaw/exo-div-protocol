import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  open_database_connection,
  type DatabaseConnection,
} from '../../../src/db/database_connection';
import { auth_user } from '../../../src/db/schema/auth_schema';
import { DrizzleLawyerAccountRepository } from '../../../src/auth/drizzle_lawyer_account_repository';
import { Argon2idLawyerPasswordHasher } from '../../../src/auth/lawyer_password_hasher';
import {
  bootstrap_demo_lawyer_account,
  LawyerAccountAlreadyExistsError,
} from '../../../src/auth/lawyer_account_bootstrap';
import { build_capturing_logger } from '../../helpers/capturing_logger';

const PLAINTEXT_PASSWORD = 'tulipe orage marbre cerise lanterne';

function require_database_url(): string {
  const database_url: string | undefined = process.env.DATABASE_URL;
  if (database_url === undefined || database_url === '') {
    throw new Error('DATABASE_URL est requis : ce test ecrit dans un vrai Postgres');
  }
  return database_url;
}

// Revue offensive du 2026-09-08. La memoire fonde l'idempotence de l'amorcage
// sur la contrainte UNIQUE de la base, en disant explicitement que la lecture
// prealable n'est qu'un raccourci. Or drizzle-orm ENVELOPPE l'erreur du pilote :
// le SQLSTATE 23505 se trouve sur `.cause.code`, pas sur `.code`. La traduction
// ne se declenchait donc jamais, et la garantie annoncee etait injoignable.
describe("l'unicite du compte avocat est garantie par la base", () => {
  let connection: DatabaseConnection;
  let repository: DrizzleLawyerAccountRepository;
  let email: string;

  beforeAll(() => {
    connection = open_database_connection(require_database_url(), build_capturing_logger());
    repository = new DrizzleLawyerAccountRepository(
      connection.database,
      new Argon2idLawyerPasswordHasher(),
    );
  });

  beforeEach(() => {
    email = `bootstrap-${randomUUID()}@exemple.fr`;
  });

  afterEach(async () => {
    await connection.database.delete(auth_user).where(eq(auth_user.email, email));
  });

  afterAll(async () => {
    await connection.close();
  });

  it(
    'une seconde creation du meme email leve LawyerAccountAlreadyExistsError, et non ' +
      "l'erreur brute du pilote enveloppee par drizzle",
    async () => {
      await repository.create({ email, plaintext_password: PLAINTEXT_PASSWORD });

      await expect(
        repository.create({ email, plaintext_password: PLAINTEXT_PASSWORD }),
      ).rejects.toBeInstanceOf(LawyerAccountAlreadyExistsError);
    },
  );

  it(
    "deux amorcages qui se croisent : celui qui perd la course ne fait pas echouer le " +
      'demarrage, il constate simplement que le compte existe',
    async () => {
      // Le raccourci `find_id_by_email` est neutralise : c'est exactement ce que
      // vit la seconde instance quand les deux lisent avant que l'une n'ecrive.
      const repository_blind_to_existing_account = {
        find_id_by_email: async (): Promise<string | null> => null,
        create: (input: { email: string; plaintext_password: string }): Promise<string> =>
          repository.create(input),
      };

      const first_outcome = await bootstrap_demo_lawyer_account(
        { email, plaintext_password: PLAINTEXT_PASSWORD },
        { lawyer_accounts: repository_blind_to_existing_account },
      );
      const second_outcome = await bootstrap_demo_lawyer_account(
        { email, plaintext_password: PLAINTEXT_PASSWORD },
        { lawyer_accounts: repository_blind_to_existing_account },
      );

      expect(first_outcome.account_was_created).toBe(true);
      expect(second_outcome.account_was_created).toBe(false);
    },
  );

  it("une panne qui n'est pas une violation d'unicite n'est PAS absorbee", async () => {
    const unreachable_database_repository = {
      find_id_by_email: async (): Promise<string | null> => null,
      create: async (): Promise<string> => {
        throw new Error('base injoignable');
      },
    };

    await expect(
      bootstrap_demo_lawyer_account(
        { email, plaintext_password: PLAINTEXT_PASSWORD },
        { lawyer_accounts: unreachable_database_repository },
      ),
    ).rejects.toThrow('base injoignable');
  });
});
