import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ApplicationDatabase } from '../db/database_connection';
import { auth_account, auth_user } from '../db/schema/auth_schema';
import { normalize_lawyer_email } from '../shared/lawyer_credentials';
import {
  LawyerAccountAlreadyExistsError,
  type LawyerAccountBootstrapInput,
  type LawyerAccountRepository,
} from './lawyer_account_bootstrap';
import type { LawyerPasswordHasher } from './lawyer_password_hasher';

// SQLSTATE 23505 : violation d'une contrainte d'unicite. C'est la garantie
// reelle d'unicite du compte — la lecture prealable n'est qu'un raccourci — et
// c'est ici, au contact de Postgres, qu'on la traduit en type metier.
const UNIQUE_VIOLATION_SQLSTATE = '23505';

// BetterAuth traite le couple email/mot de passe comme un fournisseur parmi
// d'autres : le hachage vit dans `account`, pas dans `user`, et le compte
// « mot de passe » se reconnait a ce providerId.
const CREDENTIAL_PROVIDER_ID = 'credential';

function is_unique_violation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE
  );
}

// L'inscription HTTP est fermee (`disableSignUp`), et ce drapeau ferme aussi la
// voie programmatique `auth.api.signUpEmail` — verifie dans le handler de la
// version installee. L'amorcage ecrit donc les deux lignes lui-meme, avec le
// meme hacheur que celui que BetterAuth utilisera a la verification.
export class DrizzleLawyerAccountRepository implements LawyerAccountRepository {
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly password_hasher: LawyerPasswordHasher,
  ) {}

  async find_id_by_email(email: string): Promise<string | null> {
    const rows = await this.database
      .select({ id: auth_user.id })
      .from(auth_user)
      .where(eq(auth_user.email, normalize_lawyer_email(email)))
      .limit(1);

    return rows[0]?.id ?? null;
  }

  async create(input: LawyerAccountBootstrapInput): Promise<string> {
    const normalized_email: string = normalize_lawyer_email(input.email);
    const user_id: string = randomUUID();
    const password_hash: string = await this.password_hasher.hash_plaintext_password(
      input.plaintext_password,
    );

    try {
      // Une transaction, parce qu'un utilisateur sans ligne `account` serait un
      // compte sans mot de passe : il existerait, ne pourrait jamais se
      // connecter, et bloquerait l'email pour toute nouvelle tentative
      // d'amorcage.
      await this.database.transaction(async (transaction): Promise<void> => {
        await transaction.insert(auth_user).values({
          id: user_id,
          name: normalized_email,
          email: normalized_email,
          emailVerified: true,
        });

        await transaction.insert(auth_account).values({
          id: randomUUID(),
          userId: user_id,
          accountId: user_id,
          providerId: CREDENTIAL_PROVIDER_ID,
          password: password_hash,
        });
      });
    } catch (error: unknown) {
      if (is_unique_violation(error)) {
        throw new LawyerAccountAlreadyExistsError();
      }
      throw error;
    }

    return user_id;
  }
}
