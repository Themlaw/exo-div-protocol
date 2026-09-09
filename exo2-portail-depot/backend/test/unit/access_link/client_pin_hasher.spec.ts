import {
  Argon2idClientPinHasher,
  ConcurrencyBoundedPinHasher,
  CLIENT_PIN_HASHING_PARAMETERS,
  PinVerificationTemporarilyUnavailableError,
} from '../../../src/access_link/client_pin_hasher';
import { LAWYER_PASSWORD_HASHING_PARAMETERS } from '../../../src/auth/lawyer_password_hasher';
import type { PinHasher } from '../../../src/domain/verify_client_pin';
import {
  build_argon2_concurrency_gate,
  type Argon2ConcurrencyGate,
} from '../../../src/shared/argon2_concurrency_gate';

const REFERENCE_PIN = '482173';

// Deux places seulement : le comportement du portillon est le meme a 2 qu'a 4,
// et un test qui devrait lancer quatre hachages argon2 concurrents pour
// observer la file couterait une seconde a chaque execution.
const TWO_PLACE_BOUNDS = {
  maximum_concurrent_evaluations: 2,
  maximum_queued_evaluations: 1,
} as const;

function build_blocking_pin_hasher(): {
  hasher: PinHasher;
  release_all_verifications: () => void;
  verifications_in_flight: () => number;
} {
  let in_flight = 0;
  const pending_resolvers: ((verified: boolean) => void)[] = [];

  return {
    hasher: {
      hash: async (): Promise<string> => 'hash-fictif',
      verify: (): Promise<boolean> => {
        in_flight += 1;
        return new Promise<boolean>((resolve): void => {
          pending_resolvers.push(resolve);
        });
      },
    },
    release_all_verifications: (): void => {
      for (const resolve of pending_resolvers.splice(0)) {
        resolve(false);
      }
    },
    verifications_in_flight: (): number => in_flight,
  };
}

describe('Argon2idClientPinHasher', () => {
  it('[68] deux liens portant le meme PIN produisent deux hachages differents, et la valeur stockee ne contient jamais le PIN', async () => {
    const hasher = new Argon2idClientPinHasher();

    const first_link_pin_hash: string = await hasher.hash(REFERENCE_PIN);
    const second_link_pin_hash: string = await hasher.hash(REFERENCE_PIN);

    expect(first_link_pin_hash).not.toBe(second_link_pin_hash);
    expect(first_link_pin_hash).not.toContain(REFERENCE_PIN);
    expect(second_link_pin_hash).not.toContain(REFERENCE_PIN);
    await expect(hasher.verify(REFERENCE_PIN, second_link_pin_hash)).resolves.toBe(true);
  });

  // Les parametres sont une decision de securite : les affirmer ici fait qu'une
  // modification devient un geste explicite et relu.
  it('porte reellement les parametres decides, et les memes que le mot de passe avocat', async () => {
    expect(CLIENT_PIN_HASHING_PARAMETERS).toEqual(LAWYER_PASSWORD_HASHING_PARAMETERS);

    const pin_hash: string = await new Argon2idClientPinHasher().hash(REFERENCE_PIN);

    expect(pin_hash.startsWith('$argon2id$')).toBe(true);
    expect(pin_hash).toContain('m=65536,t=8,p=2');
  });

  it('verifie un PIN correct et refuse un PIN faux', async () => {
    const hasher = new Argon2idClientPinHasher();
    const pin_hash: string = await hasher.hash(REFERENCE_PIN);

    await expect(hasher.verify(REFERENCE_PIN, pin_hash)).resolves.toBe(true);
    await expect(hasher.verify('000000', pin_hash)).resolves.toBe(false);
  });

  it("rend false sur un hachage illisible plutot que de lever : un 500 distinguerait ce lien de tous les autres", async () => {
    await expect(
      new Argon2idClientPinHasher().verify(REFERENCE_PIN, 'pas-un-hachage'),
    ).resolves.toBe(false);
  });
});

describe('ConcurrencyBoundedPinHasher', () => {
  it('au-dela du plafond, la verification ATTEND au lieu de lancer un hachage de plus', async () => {
    const { hasher, release_all_verifications, verifications_in_flight } =
      build_blocking_pin_hasher();
    const gate: Argon2ConcurrencyGate = build_argon2_concurrency_gate(TWO_PLACE_BOUNDS);
    const bounded_hasher = new ConcurrencyBoundedPinHasher(hasher, gate);

    const verifications: Promise<boolean>[] = [
      bounded_hasher.verify(REFERENCE_PIN, 'hash-1'),
      bounded_hasher.verify(REFERENCE_PIN, 'hash-2'),
      bounded_hasher.verify(REFERENCE_PIN, 'hash-3'),
    ];
    await Promise.resolve();

    expect(verifications_in_flight()).toBe(TWO_PLACE_BOUNDS.maximum_concurrent_evaluations);

    release_all_verifications();
    await Promise.all(verifications.slice(0, 2));
    release_all_verifications();
    await Promise.all(verifications);
  });

  it('la file pleine, la verification est refusee par une erreur typee que le transport traduira en 503', async () => {
    const { hasher, release_all_verifications } = build_blocking_pin_hasher();
    const gate: Argon2ConcurrencyGate = build_argon2_concurrency_gate(TWO_PLACE_BOUNDS);
    const bounded_hasher = new ConcurrencyBoundedPinHasher(hasher, gate);

    const saturating_verifications: Promise<boolean>[] = [
      bounded_hasher.verify(REFERENCE_PIN, 'hash-1'),
      bounded_hasher.verify(REFERENCE_PIN, 'hash-2'),
      bounded_hasher.verify(REFERENCE_PIN, 'hash-3'),
    ];

    await expect(bounded_hasher.verify(REFERENCE_PIN, 'hash-4')).rejects.toBeInstanceOf(
      PinVerificationTemporarilyUnavailableError,
    );

    // Deux liberations : la premiere rend les deux places occupees, ce qui
    // admet la verification restee en file — laquelle demande a son tour a
    // etre liberee.
    release_all_verifications();
    await Promise.all(saturating_verifications.slice(0, 2));
    release_all_verifications();
    await Promise.all(saturating_verifications);
  });

  // Sans cela, quatre exceptions suffiraient a fermer la route a tout le monde,
  // definitivement, et rien ne le signalerait.
  it('rend sa place meme quand la verification leve', async () => {
    const failing_hasher: PinHasher = {
      hash: async (): Promise<string> => 'hash-fictif',
      verify: async (): Promise<boolean> => {
        throw new Error('echec du hachage');
      },
    };
    const gate: Argon2ConcurrencyGate = build_argon2_concurrency_gate(TWO_PLACE_BOUNDS);
    const bounded_hasher = new ConcurrencyBoundedPinHasher(failing_hasher, gate);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(bounded_hasher.verify(REFERENCE_PIN, 'hash')).rejects.toThrow(
        'echec du hachage',
      );
    }

    // Les places ont bien ete rendues : le portillon admet encore, alors que
    // dix echecs auraient suffi a l'epuiser deux fois.
    await expect(gate.enter()).resolves.toMatchObject({ kind: 'admitted' });
  });
});
