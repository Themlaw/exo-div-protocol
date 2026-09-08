import {
  normalize_client_ip,
  resolve_trusted_client_ip,
} from '../../../src/auth/login_throttling';

const DIRECT_ADDRESS = '9.9.9.9';

describe('[F4a] resolve_trusted_client_ip ne doit jamais lever', () => {
  // Mesure sur le code d'origine : `NaN <= 0` est faux ET `NaN > length` est
  // faux, donc les deux gardes sont franchies, `chain[NaN]` vaut `undefined` et
  // `.trim()` leve. Une TypeError ici, c'est un 500 sur CHAQUE tentative de
  // connexion, donc un deni de service total du login declenche par une simple
  // variable d'environnement mal renseignee.
  const malformed_hop_counts: ReadonlyArray<readonly [string, number]> = [
    ['NaN', Number.NaN],
    ['fractionnaire', 1.5],
    ['negatif', -3],
    ['infini', Number.POSITIVE_INFINITY],
    ['infini negatif', Number.NEGATIVE_INFINITY],
  ];

  it.each(malformed_hop_counts)(
    'un nombre de sauts %s retombe sur l adresse directe au lieu de lever',
    (_label: string, trusted_proxy_hop_count: number) => {
      expect(() =>
        resolve_trusted_client_ip(
          ['1.1.1.1', '2.2.2.2'],
          DIRECT_ADDRESS,
          trusted_proxy_hop_count,
        ),
      ).not.toThrow();

      expect(
        resolve_trusted_client_ip(['1.1.1.1', '2.2.2.2'], DIRECT_ADDRESS, trusted_proxy_hop_count),
      ).toBe(DIRECT_ADDRESS);
    },
  );
});

describe('[F4b] normalize_client_ip refuse ce que Postgres ne sait pas stocker', () => {
  // `isIP('fe80::1%eth0')` rend 6, mais `'fe80::1%eth0'::inet` leve
  // « invalid input syntax for type inet ». Or `req.socket.remoteAddress`
  // produit exactement cette forme pour un pair IPv6 lien-local : l'INSERT du
  // compteur echouerait, donc l'echec ne serait PAS compte.
  it.each([
    ['identifiant de zone', 'fe80::1%eth0'],
    ['identifiant de zone numerique', 'fe80::1%1'],
    ['chaine vide', ''],
    ['pas une adresse', 'pas-une-adresse'],
    ['masque de sous-reseau', '1.2.3.4/24'],
    ['adresse avec port', '1.2.3.4:5432'],
  ])('rend null pour %s', (_label: string, value: string) => {
    expect(normalize_client_ip(value)).toBeNull();
  });

  it('accepte une IPv4 et une IPv6 ordinaires', () => {
    expect(normalize_client_ip('203.0.113.7')).toBe('203.0.113.7');
    expect(normalize_client_ip('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('[F4c] normalize_client_ip canonicalise, sinon un client occupe deux compteurs', () => {
  // Postgres : `'1.2.3.4'::inet = '::ffff:1.2.3.4'::inet` rend FAUX. Une socket
  // double pile rapporte la forme mappee, un en-tete rapporte la forme pure :
  // le meme attaquant se verrait attribuer deux budgets de tentatives.
  it.each([
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
  ])('%s est ramene a %s', (mapped: string, expected: string) => {
    expect(normalize_client_ip(mapped)).toBe(expected);
  });

  it('deux ecritures de la meme adresse donnent la meme clef de comptage', () => {
    expect(normalize_client_ip('::ffff:1.2.3.4')).toBe(normalize_client_ip('1.2.3.4'));
  });

  it('la casse d une IPv6 ne cree pas deux compteurs', () => {
    expect(normalize_client_ip('2001:DB8::1')).toBe(normalize_client_ip('2001:db8::1'));
  });
});

describe('resolve_trusted_client_ip : la chaine reste lue par la droite', () => {
  it("un client qui forge le debut de la chaine ne change pas d'identite", () => {
    const forged_chain: readonly string[] = ['1.1.1.1', '6.6.6.6', '203.0.113.7'];

    expect(resolve_trusted_client_ip(forged_chain, DIRECT_ADDRESS, 1)).toBe('203.0.113.7');
  });

  it('une chaine plus courte que le nombre de sauts declares retombe sur l adresse directe', () => {
    expect(resolve_trusted_client_ip(['1.1.1.1'], DIRECT_ADDRESS, 3)).toBe(DIRECT_ADDRESS);
  });

  it("l'adresse retenue est normalisee, comme celle de la socket", () => {
    expect(resolve_trusted_client_ip(['::ffff:203.0.113.7'], DIRECT_ADDRESS, 1)).toBe(
      '203.0.113.7',
    );
  });

  it("une entree non stockable au bon endroit de la chaine ne devient pas l'identite", () => {
    expect(resolve_trusted_client_ip(['fe80::1%eth0'], DIRECT_ADDRESS, 1)).toBe(DIRECT_ADDRESS);
  });
});
