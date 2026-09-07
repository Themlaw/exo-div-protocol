export type NodeEnvironment = 'development' | 'test' | 'production';

export interface LawyerAccountBootstrapInput {
  email: string;
  password: string;
}

export interface LawyerAccountBootstrapOutcome {
  // `false` quand le compte existait deja : relancer install.sh ne doit rien
  // dupliquer ni echouer.
  account_was_created: boolean;
}

export interface LawyerAccountRepository {
  find_id_by_email(email: string): Promise<string | null>;
  create(input: LawyerAccountBootstrapInput): Promise<string>;
}

export async function bootstrap_demo_lawyer_account(
  input: LawyerAccountBootstrapInput,
  dependencies: { lawyer_accounts: LawyerAccountRepository },
): Promise<LawyerAccountBootstrapOutcome> {
  const existing_id: string | null = await dependencies.lawyer_accounts.find_id_by_email(
    input.email,
  );

  // Idempotent : relancer install.sh ne doit rien dupliquer ni echouer, donc
  // un compte deja present n'est pas recree.
  if (existing_id !== null) {
    return { account_was_created: false };
  }

  await dependencies.lawyer_accounts.create(input);
  return { account_was_created: true };
}

export class DevelopmentSeedInProductionError extends Error {
  constructor() {
    super("Le seed de developpement ne s'execute pas en production");
    this.name = 'DevelopmentSeedInProductionError';
  }
}

export function assert_development_seed_allowed(
  node_environment: NodeEnvironment,
): void {
  // Seed de developpement : donnees d'exemple, jamais executees en production.
  if (node_environment === 'production') {
    throw new DevelopmentSeedInProductionError();
  }
}
