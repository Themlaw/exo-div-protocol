import { hash, verify, type Algorithm } from '@node-rs/argon2';
import type { PinHasher } from '../domain/verify_client_pin';
import type {
  Argon2ConcurrencyAdmission,
  Argon2ConcurrencyGate,
} from '../shared/argon2_concurrency_gate';

// `Algorithm` est un `const enum` ambiant : sous `isolatedModules`, il n'existe
// pas a l'execution et ne peut donc pas etre lu comme une valeur.
const ARGON2ID: Algorithm = 2;

export const CLIENT_PIN_HASHER: unique symbol = Symbol('CLIENT_PIN_HASHER');

// Exactement les parametres du mot de passe avocat, et surtout PAS des
// parametres allegees sous pretexte que la route est anonyme. Un PIN de six
// chiffres derriere un hachage rapide se casse hors ligne en quelques minutes —
// or c'est precisement le scenario que le hachage existe pour couvrir. Le cout
// offert a un attaquant anonyme est borne ailleurs, par le portillon de
// concurrence, qui lui ne sacrifie rien si la base fuite.
//
// Constante distincte plutot que reference partagee : ce sont deux decisions,
// qui peuvent legitimement diverger le jour ou l'une des deux surfaces est
// recalibree. Un test affirme leur egalite d'aujourd'hui, de sorte qu'une
// divergence soit un geste explicite et non une derive.
export const CLIENT_PIN_HASHING_PARAMETERS = {
  memory_cost_kibibytes: 65_536,
  time_cost: 8,
  parallelism: 2,
} as const;

export class Argon2idClientPinHasher implements PinHasher {
  // Le sel est tire par argon2 a chaque appel et voyage dans l'encodage : deux
  // liens portant le meme PIN ne se reconnaissent donc pas. Sans lui, une base
  // volee se casserait une seule fois pour tous les liens a la fois — et un PIN
  // a six chiffres n'a que dix mille... un million de valeurs possibles.
  async hash(pin: string): Promise<string> {
    return hash(pin, {
      algorithm: ARGON2ID,
      memoryCost: CLIENT_PIN_HASHING_PARAMETERS.memory_cost_kibibytes,
      timeCost: CLIENT_PIN_HASHING_PARAMETERS.time_cost,
      parallelism: CLIENT_PIN_HASHING_PARAMETERS.parallelism,
    });
  }

  async verify(pin: string, pin_hash: string): Promise<boolean> {
    try {
      return await verify(pin_hash, pin);
    } catch {
      // Un hachage illisible en base est un echec de verification, pas une
      // erreur a propager : la remontee ferait repondre 500 la ou un echec est
      // attendu, et distinguerait ce lien de tous les autres.
      return false;
    }
  }
}

// Levee quand le portillon refuse : le transport la traduit en 503 avec un
// Retry-After. `verify` rendant un booleen, elle ne peut pas dire « refuse »
// autrement — rendre `false` serait pire que tout, puisque l'appelant
// consommerait un essai du client pour un PIN qu'on n'a jamais verifie.
export class PinVerificationTemporarilyUnavailableError extends Error {
  constructor() {
    super('Verification du PIN momentanement indisponible');
    this.name = 'PinVerificationTemporarilyUnavailableError';
  }
}

// Decorateur autour du hasher, et non un appel dans le controleur : pose dans
// le controleur, on peut l'oublier sur le prochain chemin qui verifie un PIN,
// et l'oubli ne se voit pas. Ici, il est impossible a contourner.
export class ConcurrencyBoundedPinHasher implements PinHasher {
  constructor(
    private readonly delegate: PinHasher,
    private readonly concurrency_gate: Argon2ConcurrencyGate,
  ) {}

  // Le hachage n'est PAS plafonne, seulement la verification : hacher n'arrive
  // qu'a la creation d'un lien, donc derriere une session avocat deja etablie,
  // et en un exemplaire par demande. La verification, elle, est offerte a
  // quiconque possede l'URL.
  async hash(pin: string): Promise<string> {
    return this.delegate.hash(pin);
  }

  async verify(pin: string, pin_hash: string): Promise<boolean> {
    const admission: Argon2ConcurrencyAdmission = await this.concurrency_gate.enter();

    if (admission.kind === 'queue_full') {
      throw new PinVerificationTemporarilyUnavailableError();
    }

    try {
      return await this.delegate.verify(pin, pin_hash);
    } finally {
      // `finally` et non une liberation apres l'appel : une verification qui
      // leve doit rendre sa place, sinon quatre erreurs fermeraient la route a
      // tout le monde, definitivement et sans que rien ne le signale.
      admission.release();
    }
  }
}
