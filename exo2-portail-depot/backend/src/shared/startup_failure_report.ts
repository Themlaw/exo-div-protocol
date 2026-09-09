import { InvalidEnvironmentError } from '../config/environment';
import { redact_secrets_in_text } from './logging/application_logger';

export const STARTUP_FAILURE_PREFIX = "Demarrage refuse";

// Ce rapport est ecrit AVANT que le conteneur d'injection existe : il ne peut
// donc pas passer par `ApplicationLogger`. Il passe quand meme par le masquage
// des secrets — c'est la seule ligne que produira un demarrage rate, et elle
// finit dans les journaux de l'orchestrateur comme les autres.
export function describe_startup_failure(error: unknown): string {
  if (error instanceof InvalidEnvironmentError) {
    const described_violations: string = error.violations
      .map((violation): string => `  - ${violation.variable} : ${violation.reason}`)
      .join('\n');

    // Les noms et les raisons, jamais les valeurs : celui qui installe a besoin
    // de savoir QUELLE variable corriger, pas de retrouver un secret dans un
    // journal.
    return `${STARTUP_FAILURE_PREFIX} : configuration invalide\n${described_violations}`;
  }

  if (error instanceof Error) {
    return redact_secrets_in_text(
      `${STARTUP_FAILURE_PREFIX} : ${error.name} - ${error.message}\n${error.stack ?? ''}`,
    );
  }

  return redact_secrets_in_text(`${STARTUP_FAILURE_PREFIX} : ${String(error)}`);
}
