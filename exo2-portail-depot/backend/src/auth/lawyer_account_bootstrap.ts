import { NotImplementedError } from '../domain/not_implemented';

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

export function bootstrap_demo_lawyer_account(
  _input: LawyerAccountBootstrapInput,
  _dependencies: { lawyer_accounts: LawyerAccountRepository },
): Promise<LawyerAccountBootstrapOutcome> {
  throw new NotImplementedError('bootstrap_demo_lawyer_account');
}

export class DevelopmentSeedInProductionError extends Error {
  constructor() {
    super("Le seed de developpement ne s'execute pas en production");
    this.name = 'DevelopmentSeedInProductionError';
  }
}

export function assert_development_seed_allowed(
  _node_environment: NodeEnvironment,
): void {
  throw new NotImplementedError('assert_development_seed_allowed');
}
