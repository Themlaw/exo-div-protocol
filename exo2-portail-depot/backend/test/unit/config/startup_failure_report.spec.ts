import {
  describe_startup_failure,
  STARTUP_FAILURE_PREFIX,
} from '../../../src/shared/startup_failure_report';
import { InvalidEnvironmentError } from '../../../src/config/environment';

// Trouve en verifiant les correctifs de la revue : `logger: false` combine au
// `abortOnError` par defaut de Nest faisait mourir le processus SANS AUCUNE
// SORTIE sur une configuration invalide. La validation d'environnement existe
// pour transformer une panne obscure en message clair au demarrage — elle
// produisait exactement l'inverse, et install.sh n'avait rien a lire.
describe('describe_startup_failure', () => {
  it("nomme chaque variable fautive et sa raison : c'est ce que lit celui qui installe", () => {
    const report: string = describe_startup_failure(
      new InvalidEnvironmentError([
        { variable: 'BETTER_AUTH_SECRET', reason: 'missing' },
        { variable: 'PUBLIC_BASE_URL', reason: 'development_value_in_production' },
      ]),
    );

    expect(report).toContain(STARTUP_FAILURE_PREFIX);
    expect(report).toContain('BETTER_AUTH_SECRET');
    expect(report).toContain('missing');
    expect(report).toContain('PUBLIC_BASE_URL');
    expect(report).toContain('development_value_in_production');
  });

  it('ne recopie aucune valeur, seulement des noms de variables et des raisons', () => {
    const report: string = describe_startup_failure(
      new InvalidEnvironmentError([{ variable: 'DEMO_LAWYER_PASSWORD', reason: 'malformed' }]),
    );

    expect(report).not.toContain('=');
  });

  it("une panne qui n'est pas de configuration reste lisible, avec son type et son message", () => {
    const report: string = describe_startup_failure(new Error('base injoignable'));

    expect(report).toContain('Error');
    expect(report).toContain('base injoignable');
  });

  it('un secret present dans le message d une panne quelconque est masque', () => {
    const report: string = describe_startup_failure(
      new Error('echec sur postgres://portail:mot-de-passe-secret@base:5432/portail'),
    );

    expect(report).not.toContain('mot-de-passe-secret');
  });

  it('une valeur levee qui n est pas une Error reste rapportee plutot que perdue', () => {
    expect(describe_startup_failure('panne opaque')).toContain('panne opaque');
  });
});
