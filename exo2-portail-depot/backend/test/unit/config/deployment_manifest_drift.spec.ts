import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENVIRONMENT_VARIABLE_NAMES,
  REQUIRED_ENVIRONMENT_VARIABLES,
} from '../../../src/config/environment';

// Le manifeste de deploiement n'herite de rien : Compose ne transmet au
// conteneur que les variables qu'il nomme, une par une. Ajouter une variable
// requise dans `environment.ts` sans l'ajouter ici donne une application qui
// passe toute la CI — laquelle fabrique son `.env` a la main — et refuse de
// demarrer sur la machine de deploiement. C'est arrive.
const DEPLOYMENT_MANIFEST_PATH: string = join(__dirname, '../../../../infra/docker-compose.yml');
const ENVIRONMENT_EXAMPLE_PATH: string = join(__dirname, '../../../../.env.example');

// Les deux services qui font tourner le code du backend, donc les deux qui
// analysent l'environnement au demarrage et refusent de vivre sans.
const SERVICES_RUNNING_THE_BACKEND: readonly string[] = ['app', 'worker'];

function read_environment_keys_of_service(manifest: string, service_name: string): ReadonlySet<string> {
  const lines: readonly string[] = manifest.split('\n');
  const service_start: number = lines.findIndex((line: string): boolean => line === `  ${service_name}:`);
  expect(service_start).toBeGreaterThanOrEqual(0);

  const keys = new Set<string>();
  let inside_environment_block = false;

  for (const line of lines.slice(service_start + 1)) {
    const starts_another_service: boolean = /^ {2}\S/.test(line);
    if (starts_another_service) {
      break;
    }

    if (/^ {4}\S/.test(line)) {
      inside_environment_block = line === '    environment:';
      continue;
    }

    const declared_variable: RegExpMatchArray | null = inside_environment_block
      ? line.match(/^ {6}([A-Z][A-Z0-9_]*):/)
      : null;
    if (declared_variable?.[1] !== undefined) {
      keys.add(declared_variable[1]);
    }
  }

  return keys;
}

describe('Derive entre la configuration attendue et le manifeste de deploiement', () => {
  const manifest: string = readFileSync(DEPLOYMENT_MANIFEST_PATH, 'utf8');

  it.each(SERVICES_RUNNING_THE_BACKEND)(
    'le service %s recoit toutes les variables requises par le backend',
    (service_name: string) => {
      const transmitted: ReadonlySet<string> = read_environment_keys_of_service(manifest, service_name);

      const absent: readonly string[] = REQUIRED_ENVIRONMENT_VARIABLES.filter(
        (variable_name: string): boolean => !transmitted.has(variable_name),
      );

      expect(absent).toEqual([]);
    },
  );

  it('.env.example declare toutes les variables requises, y compris les facultatives connues', () => {
    const example: string = readFileSync(ENVIRONMENT_EXAMPLE_PATH, 'utf8');

    const undeclared: readonly string[] = Object.values(ENVIRONMENT_VARIABLE_NAMES).filter(
      (variable_name: string): boolean =>
        !new RegExp(`^${variable_name}=`, 'm').test(example) &&
        REQUIRED_ENVIRONMENT_VARIABLES.includes(variable_name),
    );

    expect(undeclared).toEqual([]);
  });
});
