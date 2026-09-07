import {
  bootstrap_demo_lawyer_account,
  assert_development_seed_allowed,
  DevelopmentSeedInProductionError,
  type LawyerAccountBootstrapInput,
  type LawyerAccountBootstrapOutcome,
  type LawyerAccountRepository,
  type NodeEnvironment,
} from '../../../src/auth/lawyer_account_bootstrap';

function build_lawyer_accounts_repository(
  existing_id: string | null,
): LawyerAccountRepository {
  return {
    find_id_by_email: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(existing_id),
    create: jest.fn<Promise<string>, [LawyerAccountBootstrapInput]>().mockResolvedValue('lawyer-id'),
  };
}

describe('bootstrap_demo_lawyer_account', () => {
  const input: LawyerAccountBootstrapInput = {
    email: 'demo@example.test',
    password: 'un-mot-de-passe-solide',
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

    expect(JSON.stringify(outcome)).not.toContain(input.password);
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
