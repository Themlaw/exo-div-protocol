import { verify } from '@node-rs/argon2';
import {
  Argon2idLawyerPasswordHasher,
  LAWYER_PASSWORD_HASHING_PARAMETERS,
} from '../../../src/auth/lawyer_password_hasher';

const PLAINTEXT_PASSWORD = 'tulipe orage marbre cerise lanterne';

describe('Argon2idLawyerPasswordHasher', () => {
  // Les parametres sont une decision de securite : les affirmer ici fait qu'une
  // modification devient un geste explicite et relu, jamais un reglage discret.
  // Revue offensive du 2026-09-08 : t=3 mesurait 49 ms, tres en dessous de la
  // cible de 250-500 ms qu'on avait decidee.
  it('les parametres sont ceux decides, et le hachage les porte reellement', async () => {
    expect(LAWYER_PASSWORD_HASHING_PARAMETERS).toEqual({
      memory_cost_kibibytes: 65_536,
      time_cost: 8,
      parallelism: 2,
    });

    const password_hash: string = await new Argon2idLawyerPasswordHasher().hash_plaintext_password(
      PLAINTEXT_PASSWORD,
    );

    expect(password_hash.startsWith('$argon2id$')).toBe(true);
    expect(password_hash).toContain('m=65536,t=8,p=2');
  });

  it('un mot de passe correct est verifie, un mot de passe faux ne l est pas', async () => {
    const hasher = new Argon2idLawyerPasswordHasher();
    const password_hash: string = await hasher.hash_plaintext_password(PLAINTEXT_PASSWORD);

    await expect(
      hasher.verify_plaintext_password({ password_hash, plaintext_password: PLAINTEXT_PASSWORD }),
    ).resolves.toBe(true);
    await expect(
      hasher.verify_plaintext_password({ password_hash, plaintext_password: 'autre chose entier' }),
    ).resolves.toBe(false);
  });

  it('chaque hachage porte un sel distinct : deux comptes au meme mot de passe ne se reconnaissent pas', async () => {
    const hasher = new Argon2idLawyerPasswordHasher();

    const first_hash: string = await hasher.hash_plaintext_password(PLAINTEXT_PASSWORD);
    const second_hash: string = await hasher.hash_plaintext_password(PLAINTEXT_PASSWORD);

    expect(first_hash).not.toBe(second_hash);
    await expect(verify(second_hash, PLAINTEXT_PASSWORD)).resolves.toBe(true);
  });

  it(
    "un hachage illisible en base rend false plutot que de lever : une remontee ferait " +
      'repondre 500 la ou un echec est attendu, et distinguerait ce compte des autres',
    async () => {
      await expect(
        new Argon2idLawyerPasswordHasher().verify_plaintext_password({
          password_hash: 'pas-un-hachage',
          plaintext_password: PLAINTEXT_PASSWORD,
        }),
      ).resolves.toBe(false);
    },
  );
});
