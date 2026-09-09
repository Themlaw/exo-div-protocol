import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES,
  NEUTRAL_AUTHENTICATION_FAILURE_MESSAGE,
  build_lawyer_auth_logger,
  neutralize_authentication_failure_message,
} from '../../../src/auth/lawyer_auth_logging';
import { build_capturing_logger } from '../../helpers/capturing_logger';
import { format_log_entry } from '../../../src/shared/logging/application_logger';

// Version sur laquelle les messages ci-dessous ont ete releves. `package.json`
// l'epingle a l'exact, sans accent circonflexe : ces chaines sont un detail
// interne de la bibliotheque, que rien ne l'engage a conserver. Une montee de
// version doit donc rouvrir ce fichier, pas passer au vert par accident.
const VERIFIED_BETTER_AUTH_VERSION = '1.7.3';

// Chemin de fichier, et non `require('better-auth/package.json')` : le
// manifeste n'est pas expose par la carte `exports` du paquet, donc aucun
// resolveur ne sait le rendre. Ce test lit la bibliotheque installee comme un
// fichier, ce qui est precisement son objet.
const INSTALLED_BETTER_AUTH_PATH = resolve(__dirname, '..', '..', '..', 'node_modules', 'better-auth');

function read_installed_better_auth_version(): string {
  const package_manifest: { version?: unknown } = JSON.parse(
    readFileSync(resolve(INSTALLED_BETTER_AUTH_PATH, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof package_manifest.version === 'string' ? package_manifest.version : '';
}

// Les journaux d'echec de connexion vivent dans le handler de /sign-in/email.
// On borne la lecture a ce handler : les messages du handler social voisin
// parlent d'autre chose et pollueraient la comparaison.
function read_sign_in_email_handler_source(): string {
  const sign_in_module_path: string = resolve(
    INSTALLED_BETTER_AUTH_PATH,
    'dist',
    'api',
    'routes',
    'sign-in.mjs',
  );
  const source: string = readFileSync(sign_in_module_path, 'utf8');

  const handler_start: number = source.indexOf('createAuthEndpoint("/sign-in/email"');
  expect(handler_start).toBeGreaterThan(-1);

  return source.slice(handler_start);
}

// Un `logger.warn` a un seul argument : c'est la forme des trois branches
// d'echec. Celles qui passent un contexte en second argument decrivent une
// erreur de configuration, pas une tentative de connexion.
const SINGLE_ARGUMENT_WARNING_SHAPE = /logger\.warn\("([^"]+)"\)/g;

function extract_warning_messages(source: string): readonly string[] {
  return [...source.matchAll(SINGLE_ARGUMENT_WARNING_SHAPE)].map(
    (match: RegExpMatchArray): string => match[1]!,
  );
}

describe('les messages d echec de connexion de BetterAuth', () => {
  it(
    "la version installee est celle sur laquelle les messages ont ete releves : une " +
      'montee de version doit forcer une nouvelle verification, pas etre absorbee en silence',
    () => {
      expect(read_installed_better_auth_version()).toBe(VERIFIED_BETTER_AUTH_VERSION);
    },
  );

  it(
    'la liste que nous neutralisons couvre exactement les messages emis par le handler ' +
      "installe : un message ajoute ou renomme en amont rouvrirait l'oracle d'enumeration " +
      'sans que rien ne le signale',
    () => {
      const emitted_messages: readonly string[] = extract_warning_messages(
        read_sign_in_email_handler_source(),
      );

      expect([...emitted_messages].sort()).toEqual(
        [...DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES].sort(),
      );
    },
  );

  it('chacun de ces messages est bien rabattu sur le message neutre', () => {
    for (const message of DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES) {
      expect(neutralize_authentication_failure_message(message)).toBe(
        NEUTRAL_AUTHENTICATION_FAILURE_MESSAGE,
      );
    }
  });

  it(
    "les trois branches d'echec deviennent une seule et meme ligne de journal : " +
      "c'est ce qui empeche de distinguer un compte inexistant d'un mot de passe faux",
    () => {
      const capturing_logger = build_capturing_logger();
      const better_auth_logger = build_lawyer_auth_logger(capturing_logger);

      for (const message of DISTINGUISHING_AUTHENTICATION_FAILURE_MESSAGES) {
        better_auth_logger.log('warn', message);
      }

      const logged_messages: readonly string[] = capturing_logger.captured_entries.map(
        (entry): string => entry.message,
      );

      expect(new Set(logged_messages).size).toBe(1);
      expect(logged_messages[0]).toBe(NEUTRAL_AUTHENTICATION_FAILURE_MESSAGE);
    },
  );

  it("un message sans rapport n'est pas reecrit : on ne masque que ce qu'on a decide de masquer", () => {
    expect(neutralize_authentication_failure_message('Failed to create session')).toBe(
      'Failed to create session',
    );
  });
});

// Revue offensive du 2026-09-08 : la passerelle declarait `log: (level, message)`
// et jetait `...args`. Or BetterAuth appelle `logger.error(e.name, e)` : toute
// l'erreur voyage dans le second argument. La ligne structuree disait
// litteralement {"message":"Error"} pendant que la pile partait sur stderr.
describe('les arguments supplementaires de BetterAuth', () => {
  it("l'erreur passee en second argument est conservee dans les champs", () => {
    const logger = build_capturing_logger();

    build_lawyer_auth_logger(logger).log('error', 'Error', new Error('base injoignable'));

    // Passe par `format_log_entry` et non par `JSON.stringify` : les proprietes
    // d'une Error ne sont pas enumerables, seul le formatage sait les lire.
    // Verifier autrement testerait le test, pas la chaine reelle.
    const entry = logger.entries_at_level('error')[0]!;
    const formatted: string = format_log_entry({
      level: entry.level,
      message: entry.message,
      context: entry.context,
      timestamp: '2026-09-08T12:00:00.000Z',
      fields: entry.fields,
    });

    expect(formatted).toContain('base injoignable');
  });

  it('plusieurs arguments supplementaires sont tous conserves', () => {
    const logger = build_capturing_logger();

    build_lawyer_auth_logger(logger).log('warn', 'contexte', { tentative: 3 }, 'detail');

    const serialized_fields = JSON.stringify(logger.entries_at_level('warn')[0]!.fields);
    expect(serialized_fields).toContain('3');
    expect(serialized_fields).toContain('detail');
  });

  it("un appel sans argument supplementaire ne fabrique pas de champ vide", () => {
    const logger = build_capturing_logger();

    build_lawyer_auth_logger(logger).log('info', 'demarrage');

    expect(logger.entries_at_level('info')[0]!.fields).toBeUndefined();
  });
});
