import {
  bootstrap_demo_lawyer_account,
  assert_development_seed_allowed,
  DevelopmentSeedInProductionError,
  InvalidLawyerAccountBootstrapInputError,
  LawyerAccountAlreadyExistsError,
  type LawyerAccountBootstrapInput,
  type LawyerAccountBootstrapOutcome,
  type LawyerAccountRepository,
} from '../../../src/auth/lawyer_account_bootstrap';
import type { NodeEnvironment } from '../../../src/shared/node_environment';
import {
  normalize_lawyer_email,
  LAWYER_PASSWORD_LENGTH_BOUNDS,
  MAXIMUM_LAWYER_EMAIL_LENGTH,
} from '../../../src/shared/lawyer_credentials';

function build_lawyer_accounts_repository(
  existing_id: string | null,
): LawyerAccountRepository {
  return {
    find_id_by_email: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(existing_id),
    create: jest.fn<Promise<string>, [LawyerAccountBootstrapInput]>().mockResolvedValue('lawyer-id'),
  };
}

// Une phrase de passe : ni majuscule ni caractere special, c'est exactement ce
// que install.sh generera. Un jeu de test qui exigerait l'inverse laisserait
// passer une regle de complexite qu'on ne veut pas.
const REFERENCE_PASSPHRASE = 'cheval batterie agrafe correct girafe';

describe('bootstrap_demo_lawyer_account', () => {
  const input: LawyerAccountBootstrapInput = {
    email: 'demo@example.test',
    plaintext_password: REFERENCE_PASSPHRASE,
  };

  it("[23] quand aucun compte ne porte cet email, le compte est cree et account_was_created vaut true", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);

    const outcome: LawyerAccountBootstrapOutcome = await bootstrap_demo_lawyer_account(
      input,
      { lawyer_accounts },
    );

    expect(lawyer_accounts.create).toHaveBeenCalledWith(input);
    expect(outcome.account_was_created).toBe(true);
  });

  it("[24] relancer install.sh ne doit rien dupliquer ni echouer : quand le compte existe deja, il n'est pas recree et account_was_created vaut false", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository('existing-lawyer-id');

    const outcome: LawyerAccountBootstrapOutcome = await bootstrap_demo_lawyer_account(
      input,
      { lawyer_accounts },
    );

    expect(lawyer_accounts.create).not.toHaveBeenCalled();
    expect(outcome.account_was_created).toBe(false);
  });

  it("le mot de passe n'apparait pas dans l'objet retourne", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);

    const outcome: LawyerAccountBootstrapOutcome = await bootstrap_demo_lawyer_account(
      input,
      { lawyer_accounts },
    );

    expect(JSON.stringify(outcome)).not.toContain(input.plaintext_password);
  });

  describe('[23a] validation de l email', () => {
    const invalid_emails: ReadonlyArray<readonly [string, string]> = [
      ['vide', ''],
      ['uniquement des espaces', '   '],
      ['sans arobase', 'demo.example.test'],
      ['sans domaine', 'demo@'],
      ['sans point dans le domaine', 'demo@exampletest'],
      ['avec un espace', 'de mo@example.test'],
      ['plus long que la borne', `${'a'.repeat(MAXIMUM_LAWYER_EMAIL_LENGTH)}@example.test`],
    ];

    it.each(invalid_emails)(
      'un email %s est refuse et create n est jamais appele',
      async (_label: string, email: string) => {
        const lawyer_accounts = build_lawyer_accounts_repository(null);

        await expect(
          bootstrap_demo_lawyer_account(
            { email, plaintext_password: REFERENCE_PASSPHRASE },
            { lawyer_accounts },
          ),
        ).rejects.toThrow(InvalidLawyerAccountBootstrapInputError);

        expect(lawyer_accounts.create).not.toHaveBeenCalled();
        expect(lawyer_accounts.find_id_by_email).not.toHaveBeenCalled();
      },
    );

    // Un TLD long est valide : .museum en fait 6, .international en fait 13. Une
    // borne a trois ou quatre caracteres rejetterait des adresses reelles.
    it.each(['demo@example.museum', 'demo@example.international', 'demo+suffixe@example.test'])(
      'accepte %s',
      async (email: string) => {
        const lawyer_accounts = build_lawyer_accounts_repository(null);

        await expect(
          bootstrap_demo_lawyer_account(
            { email, plaintext_password: REFERENCE_PASSPHRASE },
            { lawyer_accounts },
          ),
        ).resolves.toEqual({ account_was_created: true });
      },
    );
  });

  describe('[23b] validation du mot de passe', () => {
    const invalid_plaintext_passwords: ReadonlyArray<readonly [string, string]> = [
      ['vide', ''],
      ['trop court d un caractere', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.min - 1)],
      ['trop long d un caractere', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.max + 1)],
    ];

    it.each(invalid_plaintext_passwords)(
      'un mot de passe %s est refuse et create n est jamais appele',
      async (_label: string, plaintext_password: string) => {
        const lawyer_accounts = build_lawyer_accounts_repository(null);

        await expect(
          bootstrap_demo_lawyer_account(
            { email: 'demo@example.test', plaintext_password },
            { lawyer_accounts },
          ),
        ).rejects.toThrow(InvalidLawyerAccountBootstrapInputError);

        expect(lawyer_accounts.create).not.toHaveBeenCalled();
      },
    );

    // Aucune regle de complexite : install.sh genere une phrase de passe de cinq
    // mots, sans majuscule ni caractere special. Exiger l'inverse rendrait la
    // valeur generee invalide et pousserait vers des mots de passe plus courts.
    it.each([
      ['une phrase de passe de cinq mots', REFERENCE_PASSPHRASE],
      ['la borne basse exacte', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.min)],
      ['la borne haute exacte', 'a'.repeat(LAWYER_PASSWORD_LENGTH_BOUNDS.max)],
    ])('accepte %s', async (_label: string, plaintext_password: string) => {
      const lawyer_accounts = build_lawyer_accounts_repository(null);

      await expect(
        bootstrap_demo_lawyer_account({ email: 'demo@example.test', plaintext_password }, { lawyer_accounts }),
      ).resolves.toEqual({ account_was_created: true });
    });
  });

  it("[23c] l'erreur de validation ne contient jamais le mot de passe", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);
    const plaintext_password = 'trop-court';

    const rejection: unknown = await bootstrap_demo_lawyer_account(
      { email: 'demo@example.test', plaintext_password },
      { lawyer_accounts },
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(InvalidLawyerAccountBootstrapInputError);
    const error = rejection as InvalidLawyerAccountBootstrapInputError;
    expect(error.message).not.toContain(plaintext_password);
    expect(JSON.stringify(error.violations)).not.toContain(plaintext_password);
  });

  it("[23d] l'email est normalise avant la recherche ET avant la creation, sinon l'unicite de la base est illusoire", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);

    await bootstrap_demo_lawyer_account(
      { email: '  Demo@Example.TEST  ', plaintext_password: REFERENCE_PASSPHRASE },
      { lawyer_accounts },
    );

    expect(lawyer_accounts.find_id_by_email).toHaveBeenCalledWith('demo@example.test');
    expect(lawyer_accounts.create).toHaveBeenCalledWith({
      email: 'demo@example.test',
      plaintext_password: REFERENCE_PASSPHRASE,
    });
  });

  it("[24a] deux install.sh simultanes : la contrainte d'unicite de la base tranche, le perdant retourne account_was_created false", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);
    // find_id_by_email a repondu `null` : entre cette lecture et l'insertion,
    // l'autre execution a cree le compte. Seule la base peut arbitrer.
    lawyer_accounts.create = jest
      .fn<Promise<string>, [LawyerAccountBootstrapInput]>()
      .mockRejectedValue(new LawyerAccountAlreadyExistsError());

    await expect(
      bootstrap_demo_lawyer_account(input, { lawyer_accounts }),
    ).resolves.toEqual({ account_was_created: false });
  });

  it("[24b] une panne de la base se propage : l'idempotence ne doit pas transformer une installation morte en succes", async () => {
    const lawyer_accounts = build_lawyer_accounts_repository(null);
    const database_failure = new Error('connexion refusee');
    lawyer_accounts.create = jest
      .fn<Promise<string>, [LawyerAccountBootstrapInput]>()
      .mockRejectedValue(database_failure);

    await expect(bootstrap_demo_lawyer_account(input, { lawyer_accounts })).rejects.toBe(
      database_failure,
    );
  });
});

describe('normalize_lawyer_email', () => {
  it.each([
    ['  demo@example.test  ', 'demo@example.test'],
    ['Demo@Example.TEST', 'demo@example.test'],
    ['DEMO@EXAMPLE.MUSEUM', 'demo@example.museum'],
  ])('normalise %s en %s', (raw: string, expected: string) => {
    expect(normalize_lawyer_email(raw)).toBe(expected);
  });
});

describe('assert_development_seed_allowed', () => {
  it("[25] leve DevelopmentSeedInProductionError pour 'production'", () => {
    expect(() => assert_development_seed_allowed('production')).toThrow(
      DevelopmentSeedInProductionError,
    );
  });

  it.each<NodeEnvironment>(['development', 'test'])(
    '[25] ne leve pas pour %s',
    (node_environment: NodeEnvironment) => {
      expect(() => assert_development_seed_allowed(node_environment)).not.toThrow();
    },
  );
});
