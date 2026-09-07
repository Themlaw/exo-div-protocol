import * as crypto from 'crypto';
import {
  generate_access_link_token,
  ACCESS_LINK_TOKEN_ALPHABET,
  ACCESS_LINK_TOKEN_LENGTH,
  type RandomSource,
} from '../../../src/domain/presigned_upload';

function build_random_source(bytes: Buffer): RandomSource {
  return { bytes: jest.fn().mockReturnValue(bytes) };
}

describe('generate_access_link_token', () => {
  it('[69] produit un token de longueur ACCESS_LINK_TOKEN_LENGTH dont tous les caractères appartiennent à ACCESS_LINK_TOKEN_ALPHABET', () => {
    const random_source = build_random_source(crypto.randomBytes(256));

    const token = generate_access_link_token(random_source);

    expect(token).toHaveLength(ACCESS_LINK_TOKEN_LENGTH);
    for (const character of token) {
      expect(ACCESS_LINK_TOKEN_ALPHABET).toContain(character);
    }
  });

  it('deux RandomSource différentes produisent deux tokens différents', () => {
    const random_source_1 = build_random_source(crypto.randomBytes(256));
    const random_source_2 = build_random_source(crypto.randomBytes(256));

    const token_1 = generate_access_link_token(random_source_1);
    const token_2 = generate_access_link_token(random_source_2);

    expect(token_1).not.toBe(token_2);
  });

  it('la même source produit le même token', () => {
    const bytes = crypto.randomBytes(256);
    const random_source_1 = build_random_source(bytes);
    const random_source_2 = build_random_source(Buffer.from(bytes));

    const token_1 = generate_access_link_token(random_source_1);
    const token_2 = generate_access_link_token(random_source_2);

    expect(token_1).toBe(token_2);
  });

  it('la source aléatoire est réellement consultée : bytes() est appelé', () => {
    const random_source = build_random_source(crypto.randomBytes(256));

    generate_access_link_token(random_source);

    expect(random_source.bytes).toHaveBeenCalled();
  });

  it('sur un grand nombre de tirages avec crypto.randomBytes, tous les tokens sont distincts', () => {
    const real_random_source: RandomSource = { bytes: (length) => crypto.randomBytes(length) };

    const tokens = new Set<string>();
    for (let draw = 0; draw < 1000; draw += 1) {
      tokens.add(generate_access_link_token(real_random_source));
    }

    expect(tokens.size).toBe(1000);
  });
});
