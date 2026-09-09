import { createHmac } from 'node:crypto';
import {
  ENVIRONMENT_VARIABLE_NAMES,
  MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH,
} from '../config/environment';

// La rotation n'est PAS implementee, et cette version l'est quand meme : la
// colonne ne coute rien aujourd'hui, alors qu'ajouter la notion apres coup
// obligerait a migrer des lignes dont on ne saurait plus avec quel poivre elles
// ont ete calculees.
export const CURRENT_ACCESS_LINK_TOKEN_PEPPER_VERSION = 1;

export interface AccessLinkTokenFingerprint {
  token_hmac: string;
  token_pepper_version: number;
}

// Synchrone, contrairement au `PinHasher` : c'est une difference de nature, pas
// de commodite. Le token doit etre retrouve par un index, donc son empreinte
// est deterministe et immediate. Le PIN, lui, n'est jamais retrouve — seulement
// verifie — et sa lenteur est justement ce qui le protege.
export interface AccessLinkTokenHasher {
  fingerprint_token(token: string): AccessLinkTokenFingerprint;
}

export class InvalidAccessLinkTokenPepperError extends Error {
  constructor(received_length: number) {
    // La VALEUR recue n'est jamais citee, seulement sa longueur : une erreur de
    // demarrage part dans les journaux, et refuser un poivre ne doit pas
    // revenir a le publier.
    super(
      `${ENVIRONMENT_VARIABLE_NAMES.access_link_token_pepper} doit compter au moins ` +
        `${MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH} caracteres (recu : ${received_length}).`,
    );
    this.name = 'InvalidAccessLinkTokenPepperError';
  }
}

// Un HMAC et non un hachage simple : sans poivre, une base volee livrerait des
// liens directement utilisables — le token n'est protege par aucun secret que
// son porteur devrait connaitre, il EST le secret. Le poivre vit hors de la
// base, en variable d'environnement, et **le perdre invalide tous les liens en
// circulation**.
export class AccessLinkTokenHmacHasher implements AccessLinkTokenHasher {
  // Champ prive natif, et pas seulement `private` : le modificateur TypeScript
  // disparait a la compilation et laisserait le poivre sortir dans un
  // `JSON.stringify` de l'objet — donc, tot ou tard, dans un journal.
  readonly #pepper: string;

  constructor(pepper: string) {
    if (pepper.length < MINIMUM_ACCESS_LINK_TOKEN_PEPPER_LENGTH) {
      throw new InvalidAccessLinkTokenPepperError(pepper.length);
    }
    this.#pepper = pepper;
  }

  // Aucune normalisation du token : il vient d'une URL et se compare octet pour
  // octet. Un `trim()` ou un `toLowerCase()` pose par confort d'interface
  // reduirait l'espace de recherche au point de le rendre franchissable.
  fingerprint_token(token: string): AccessLinkTokenFingerprint {
    return {
      token_hmac: createHmac('sha256', this.#pepper).update(token, 'utf8').digest('hex'),
      token_pepper_version: CURRENT_ACCESS_LINK_TOKEN_PEPPER_VERSION,
    };
  }
}
