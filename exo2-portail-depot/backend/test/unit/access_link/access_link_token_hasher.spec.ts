import {
  AccessLinkTokenHmacHasher,
  CURRENT_ACCESS_LINK_TOKEN_PEPPER_VERSION,
  type AccessLinkTokenFingerprint,
  type AccessLinkTokenHasher,
} from '../../../src/access_link/access_link_token_hasher';
import { MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH } from '../../../src/config/environment';

const REFERENCE_PEPPER = 'poivre-de-reference-du-vecteur-fige-0123456789abcdef0123456789ab';
const OTHER_PEPPER = 'un-tout-autre-poivre-de-la-meme-longueur-0123456789abcdef01234567';
const REFERENCE_TOKEN = 'aZ09'.repeat(8);

// Calcule hors de l'implementation, avec `crypto` en ligne de commande, a
// partir de la specification seule : HMAC-SHA256, clef = poivre en UTF-8,
// message = token en UTF-8, sortie hexadecimale. Un vecteur recopie de la
// sortie du code ne prouverait que sa propre stabilite.
const REFERENCE_TOKEN_HMAC = '9be63a3c9a2652e28d891d5fe4f00057373cee98d7756e6b1dfa14f9363dfb35';

function build_hasher(pepper: string = REFERENCE_PEPPER): AccessLinkTokenHasher {
  return new AccessLinkTokenHmacHasher(pepper);
}

describe('AccessLinkTokenHmacHasher', () => {
  it('produit le meme condensat pour le meme token et le meme poivre : sans ce determinisme, aucune recherche de lien par son token n est possible', () => {
    const hasher = build_hasher();

    expect(hasher.fingerprint_token(REFERENCE_TOKEN).token_hmac).toBe(
      hasher.fingerprint_token(REFERENCE_TOKEN).token_hmac,
    );
  });

  it('produit deux condensats differents pour deux tokens differents sous le meme poivre', () => {
    const hasher = build_hasher();

    expect(hasher.fingerprint_token('premier-token').token_hmac).not.toBe(
      hasher.fingerprint_token('second-token').token_hmac,
    );
  });

  // Le test qui prouve que le poivre entre REELLEMENT dans le calcul : une base
  // volee sans le poivre ne permet de forger aucun lien.
  it('produit deux condensats differents pour le meme token sous deux poivres differents', () => {
    expect(build_hasher(REFERENCE_PEPPER).fingerprint_token(REFERENCE_TOKEN).token_hmac).not.toBe(
      build_hasher(OTHER_PEPPER).fingerprint_token(REFERENCE_TOKEN).token_hmac,
    );
  });

  it('ne laisse jamais paraitre le token dans le condensat, meme en sous-chaine', () => {
    const fingerprint: AccessLinkTokenFingerprint = build_hasher().fingerprint_token(
      REFERENCE_TOKEN,
    );

    expect(fingerprint.token_hmac).not.toContain(REFERENCE_TOKEN);
    expect(JSON.stringify(fingerprint)).not.toContain(REFERENCE_TOKEN);
  });

  // Consequence utile : aucune borne de longueur n'est necessaire en entree,
  // contrairement au PIN. Un token enorme ne fait pas travailler la machine
  // plus longtemps qu'un hachage.
  it('rend un condensat de forme fixe — 64 caracteres hexadecimaux — quelle que soit la longueur du token soumis', () => {
    const hasher = build_hasher();

    for (const token of ['', 'a', REFERENCE_TOKEN, 'x'.repeat(100_000)]) {
      expect(hasher.fingerprint_token(token).token_hmac).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accompagne toujours le condensat de la version de poivre courante : c est elle qui rendra la rotation possible sans rien reecrire', () => {
    expect(build_hasher().fingerprint_token(REFERENCE_TOKEN).token_pepper_version).toBe(
      CURRENT_ACCESS_LINK_TOKEN_PEPPER_VERSION,
    );
  });

  // Defense en profondeur : la validation d'environnement impose deja cette
  // longueur au demarrage. Ce test tient pour quiconque instancierait la classe
  // hors du module de configuration.
  it('refuse a la construction un poivre vide ou plus court que le minimum exige', () => {
    expect(() => build_hasher('')).toThrow();
    expect(() =>
      build_hasher('p'.repeat(MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH - 1)),
    ).toThrow();
    expect(() =>
      build_hasher('p'.repeat(MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH)),
    ).not.toThrow();
  });

  // LE test qui protege les liens deja en circulation. Les autres ne comparent
  // que des condensats entre eux : un changement d'encodage, d'algorithme ou
  // d'ordre des operations les laisserait tous verts, et rendrait pourtant
  // introuvable chaque lien deja envoye a un client.
  it('rend exactement le condensat de reference : un changement d algorithme rendrait introuvables tous les liens en circulation', () => {
    expect(build_hasher().fingerprint_token(REFERENCE_TOKEN).token_hmac).toBe(
      REFERENCE_TOKEN_HMAC,
    );
  });

  // Corollaire du vecteur fige : aucun sel d'instance ne s'est glisse dans le
  // constructeur. Un `randomBytes` pose la tuerait tous les liens a chaque
  // redemarrage du conteneur, et le determinisme teste plus haut, mesure dans
  // une seule instance, ne le verrait pas.
  it('produit le meme condensat depuis deux instances distinctes construites avec le meme poivre', () => {
    expect(build_hasher().fingerprint_token(REFERENCE_TOKEN).token_hmac).toBe(
      build_hasher().fingerprint_token(REFERENCE_TOKEN).token_hmac,
    );
  });

  // Pendant unitaire du test [71] : le token vient d'une URL, il se compare
  // octet pour octet. Un `trim()` ou un `toLowerCase()` pose un jour par
  // confort d'interface diviserait l'espace de recherche et le rendrait
  // franchissable.
  it('ne normalise rien : casse, espaces de bord et troncature donnent trois condensats distincts', () => {
    const hasher = build_hasher();
    const variants: string[] = [
      REFERENCE_TOKEN,
      REFERENCE_TOKEN.toLowerCase(),
      ` ${REFERENCE_TOKEN} `,
      REFERENCE_TOKEN.slice(0, -1),
    ];

    const distinct_hmacs = new Set(
      variants.map((token: string): string => hasher.fingerprint_token(token).token_hmac),
    );

    expect(distinct_hmacs.size).toBe(variants.length);
  });

  it('ne laisse fuir le poivre ni par la serialisation de l objet, ni par le message d erreur d un poivre refuse', () => {
    const too_short_pepper = 'poivre-secret-mais-trop-court';

    expect(JSON.stringify(build_hasher())).not.toContain(REFERENCE_PEPPER);

    // Une erreur de demarrage part dans les journaux, qui sont lus par plus de
    // monde que la base : refuser le poivre ne doit pas revenir a le publier.
    let refusal_message = '';
    try {
      build_hasher(too_short_pepper);
    } catch (error: unknown) {
      refusal_message = (error as Error).message;
    }

    expect(refusal_message).not.toBe('');
    expect(refusal_message).not.toContain(too_short_pepper);
  });
});
