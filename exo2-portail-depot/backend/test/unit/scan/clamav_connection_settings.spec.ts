import {
  CLAMAV_SCAN_TIMEOUT_MILLISECONDS,
  parse_clamav_connection_settings,
  type ClamavConnectionSettings,
} from '../../../src/scan/clamav_scanner';

describe('parse_clamav_connection_settings', () => {
  it('lit l\'hote et le port depuis l\'URL du scanner', () => {
    const settings: ClamavConnectionSettings = parse_clamav_connection_settings(
      'tcp://clamav.interne:3311',
    );

    expect(settings.host).toBe('clamav.interne');
    expect(settings.port).toBe(3311);
  });

  // Le port officiel de clamd : une URL qui n'en porte pas reste une adresse
  // valable, et exiger le port ferait echouer un demarrage parfaitement legitime.
  it('retient le port 3310 par defaut quand l\'URL n\'en porte pas', () => {
    const settings: ClamavConnectionSettings = parse_clamav_connection_settings(
      'tcp://clamav.interne',
    );

    expect(settings.port).toBe(3310);
  });

  it('impose le delai de scan partage a toute connexion, quelle que soit l\'URL', () => {
    const settings: ClamavConnectionSettings = parse_clamav_connection_settings(
      'tcp://clamav.interne:3310',
    );

    expect(settings.timeout_milliseconds).toBe(CLAMAV_SCAN_TIMEOUT_MILLISECONDS);
  });

  // `clamav.interne:3310` est le piege : `new URL` l'accepte, y lit un schema
  // et rend un hote VIDE, sur lequel une connexion se rabat en silence sur la
  // boucle locale. Le scanner ne serait jamais joint et rien ne le dirait.
  it.each(['', 'pas une url', 'clamav.interne:3310', 'http://clamav.interne:3310'])(
    'leve sur une adresse invalide (%s) plutot que de rendre une adresse inutilisable',
    (endpoint_url: string) => {
      expect(() => parse_clamav_connection_settings(endpoint_url)).toThrow();
    },
  );
});
