import postgres from 'postgres';
import { MAXIMUM_LAWYER_EMAIL_LENGTH } from '../../../src/shared/lawyer_credentials';

// Ces tests s'adressent a un vrai Postgres : c'est le moteur qu'on teste, pas
// notre code. Une contrainte CHECK verifiee par une simulation ne prouverait
// rien de ce qu'on attend d'elle.
const DATABASE_URL: string | undefined = process.env.DATABASE_URL;

// [F9] Ces tests font des DELETE sur les tables de limitation. Lances par
// megarde avec le .env d'une installation reelle, ils remettraient a zero tout
// l'anti-bruteforce en une commande. Meme garde-fou que pour le seed de
// developpement.
function assert_not_running_against_production(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      "Les tests d'integration effacent les compteurs de limitation : refus de s'executer avec NODE_ENV=production",
    );
  }
}

const CONSTRAINT_VIOLATION_SQLSTATE = '23514';
const UNIQUE_VIOLATION_SQLSTATE = '23505';

describe('security.lawyer_login_failure_by_account : normalisation garantie par la base', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    assert_not_running_against_production();
    if (DATABASE_URL === undefined || DATABASE_URL === '') {
      throw new Error(
        'DATABASE_URL est requis : ces tests verifient le comportement reel de Postgres',
      );
    }
    sql = postgres(DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function insert_failure_counter(email: string): Promise<void> {
    await sql`
      INSERT INTO security.lawyer_login_failure_by_account (email, consecutive_failed_attempts)
      VALUES (${email}, 1)
    `;
  }

  async function expect_rejected_by_check(email: string): Promise<void> {
    await expect(insert_failure_counter(email)).rejects.toMatchObject({
      code: CONSTRAINT_VIOLATION_SQLSTATE,
    });
  }

  beforeEach(async () => {
    await sql`DELETE FROM security.lawyer_login_failure_by_account`;
  });

  it("[a] une casse non rabattue est refusee : sans cela, alterner les variantes donnerait un compteur neuf a chaque fois", async () => {
    await expect_rejected_by_check('Demo@X.fr');
  });

  it('[b] un espace en tete ou en fin est refuse', async () => {
    await expect_rejected_by_check(' demo@x.fr');
    await expect_rejected_by_check('demo@x.fr ');
  });

  // [F3] La revue a montre que `btrim(x)` a un argument ne retire QUE l'espace
  // U+0020, la ou `String.prototype.trim()` en retire treize. Le filet cense
  // rattraper un appelant qui oublie de normaliser laissait donc passer douze
  // variantes sur treize, et le test precedent ne testait que la seule qui
  // marche. Chacune de ces valeurs donnerait un compteur d'echecs distinct,
  // donc un contournement du backoff.
  const WHITESPACE_VARIANTS: ReadonlyArray<readonly [string, string]> = [
    ['tabulation', '\u0009'],
    ['saut de ligne', '\u000a'],
    ['tabulation verticale', '\u000b'],
    ['saut de page', '\u000c'],
    ['retour chariot', '\u000d'],
    ['espace insecable', '\u00a0'],
    ['espace cadratin', '\u2000'],
    ['espace fine insecable', '\u202f'],
    ['espace mathematique', '\u205f'],
    ['espace ideographique', '\u3000'],
    ['espace ogham', '\u1680'],
    ['marque d ordre des octets', '\ufeff'],
  ];

  it.each(WHITESPACE_VARIANTS)(
    '[b bis] un(e) %s en fin est refuse au meme titre que l espace',
    async (_label: string, whitespace: string) => {
      await expect_rejected_by_check(`demo@x.fr${whitespace}`);
    },
  );

  it.each(WHITESPACE_VARIANTS)(
    '[b ter] un(e) %s en tete est refuse au meme titre que l espace',
    async (_label: string, whitespace: string) => {
      await expect_rejected_by_check(`${whitespace}demo@x.fr`);
    },
  );

  it("[b quater] la chaine vide n'est pas une clef de compteur valide", async () => {
    await expect_rejected_by_check('');
  });

  it("[b quinquies] une valeur sans arobase n'est pas une adresse", async () => {
    await expect_rejected_by_check('pas-une-adresse');
  });

  it("[c] une adresse plus longue que la borne est refusee : cette clef primaire recoit des chaines choisies par l'attaquant", async () => {
    await expect_rejected_by_check(`${'a'.repeat(MAXIMUM_LAWYER_EMAIL_LENGTH)}@x.fr`);
  });

  it('[d] une adresse normalisee est acceptee', async () => {
    await expect(insert_failure_counter('demo@x.fr')).resolves.not.toThrow();

    const rows = await sql<{ email: string }[]>`
      SELECT email FROM security.lawyer_login_failure_by_account
    `;
    expect(rows.map((row: { email: string }): string => row.email)).toEqual(['demo@x.fr']);
  });

  it("[e] deux variantes de casse ne peuvent pas coexister : le compteur reste unique par compte", async () => {
    await insert_failure_counter('demo@x.fr');
    await expect_rejected_by_check('DEMO@X.fr');

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM security.lawyer_login_failure_by_account
    `;
    expect(rows[0]?.count).toBe('1');
  });
});

// [F11] Contraintes manquantes relevees par la revue de securite.
describe('contraintes manquantes sur les compteurs et sur auth.user', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    assert_not_running_against_production();
    if (DATABASE_URL === undefined || DATABASE_URL === '') {
      throw new Error('DATABASE_URL est requis');
    }
    sql = postgres(DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM security.lawyer_login_failure_by_account`;
    await sql`DELETE FROM auth.account`;
    await sql`DELETE FROM auth."user"`;
  });

  it("un compteur negatif est refuse : un ON CONFLICT mal ecrit produirait un delai nul en silence", async () => {
    await expect(
      sql`
        INSERT INTO security.lawyer_login_failure_by_account (email, consecutive_failed_attempts)
        VALUES ('demo@x.fr', -999999)
      `,
    ).rejects.toMatchObject({ code: CONSTRAINT_VIOLATION_SQLSTATE });
  });

  // Le raisonnement « l'unicite serait illusoire » vaut identiquement ici, et
  // BetterAuth ne trimme JAMAIS l'email (verifie dans la version installee) :
  // 'demo@x.fr ' et 'demo@x.fr' sont deux lignes que user_email_unique ne
  // rapproche pas.
  it.each([
    ['une casse non rabattue', 'Demo@X.fr'],
    ['un espace en fin', 'demo@x.fr '],
    ['une tabulation en fin', 'demo@x.fr	'],
  ])('auth.user refuse %s', async (_label: string, email: string) => {
    await expect(
      sql`INSERT INTO auth."user" (id, name, email) VALUES ('u1', 'Avocat', ${email})`,
    ).rejects.toMatchObject({ code: CONSTRAINT_VIOLATION_SQLSTATE });
  });

  it('auth.user accepte une adresse normalisee', async () => {
    await expect(
      sql`INSERT INTO auth."user" (id, name, email) VALUES ('u1', 'Avocat', 'demo@x.fr')`,
    ).resolves.not.toThrow();
  });

  it("un utilisateur ne peut pas avoir deux comptes credential : deux hachages de mot de passe valides simultanement", async () => {
    await sql`INSERT INTO auth."user" (id, name, email) VALUES ('u1', 'Avocat', 'demo@x.fr')`;
    await sql`
      INSERT INTO auth.account (id, "userId", "accountId", "providerId", password)
      VALUES ('a1', 'u1', 'u1', 'credential', 'hash-1')
    `;

    await expect(
      sql`
        INSERT INTO auth.account (id, "userId", "accountId", "providerId", password)
        VALUES ('a2', 'u1', 'u1', 'credential', 'hash-2')
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION_SQLSTATE });
  });
});
