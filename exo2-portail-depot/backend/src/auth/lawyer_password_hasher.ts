import { hash, verify, type Algorithm } from '@node-rs/argon2';

// `Algorithm` est un `const enum` ambiant : sous `isolatedModules`, il n'existe
// pas a l'execution et ne peut donc pas etre lu comme une valeur. On reecrit
// la seule variante utilisee, en la nommant pour qu'elle reste lisible.
const ARGON2ID: Algorithm = 2;

// Argon2id plutot que le scrypt par defaut de BetterAuth : c'est la fonction
// recommandee aujourd'hui, et sa resistance au calcul massivement parallele
// vient de son cout memoire, que le GPU paie plein tarif.
export const LAWYER_PASSWORD_HASHING_PARAMETERS = {
  memory_cost_kibibytes: 65_536,
  time_cost: 3,
  // 2 et non 4 : le degre de parallelisme doit tenir sur la machine la plus
  // modeste ou l'installation tournera, et une VM a souvent deux coeurs. Le
  // demander plus haut que les coeurs disponibles ne rend pas le hachage plus
  // couteux pour l'attaquant, seulement plus lent pour nous.
  parallelism: 2,
} as const;

export const LAWYER_PASSWORD_HASHER: unique symbol = Symbol('LAWYER_PASSWORD_HASHER');

export interface LawyerPasswordVerificationInput {
  password_hash: string;
  plaintext_password: string;
}

export interface LawyerPasswordHasher {
  hash_plaintext_password(plaintext_password: string): Promise<string>;
  verify_plaintext_password(input: LawyerPasswordVerificationInput): Promise<boolean>;
}

export class Argon2idLawyerPasswordHasher implements LawyerPasswordHasher {
  async hash_plaintext_password(plaintext_password: string): Promise<string> {
    return hash(plaintext_password, {
      algorithm: ARGON2ID,
      memoryCost: LAWYER_PASSWORD_HASHING_PARAMETERS.memory_cost_kibibytes,
      timeCost: LAWYER_PASSWORD_HASHING_PARAMETERS.time_cost,
      parallelism: LAWYER_PASSWORD_HASHING_PARAMETERS.parallelism,
    });
  }

  async verify_plaintext_password(
    input: LawyerPasswordVerificationInput,
  ): Promise<boolean> {
    try {
      return await verify(input.password_hash, input.plaintext_password);
    } catch {
      // Un hachage illisible en base est un echec de verification, pas une
      // erreur a propager : la remontee ferait repondre 500 la ou une reponse
      // d'echec est attendue, et distinguerait ce compte de tous les autres.
      return false;
    }
  }
}
