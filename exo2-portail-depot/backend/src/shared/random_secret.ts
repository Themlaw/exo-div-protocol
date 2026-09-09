import type { RandomSource } from '../domain/presigned_upload';

// Tirage par REJET, partage par les trois secrets du produit — token de lien,
// PIN client, jeton de session. Replier l'octet sur l'alphabet (`octet % n`)
// biaiserait le tirage des que 256 n'est pas un multiple de la taille de
// l'alphabet : sur 62 caracteres, les huit premiers sortiraient un tiers plus
// souvent ; sur 10 chiffres, les six premiers. Le biais ne se voit sur aucun
// secret pris isolement, et retire pourtant de l'entropie a chacun d'eux.
export function draw_unbiased_secret(
  random_source: RandomSource,
  alphabet: string,
  secret_length: number,
): string {
  const largest_unbiased_byte_value: number =
    Math.floor(256 / alphabet.length) * alphabet.length;
  // Tire large des le premier appel : demander les octets un par un
  // multiplierait les appels au generateur du systeme pour rien.
  const bytes_drawn_at_once: number = Math.max(secret_length * 2, 16);

  const characters: string[] = [];
  let drawn_bytes: Buffer = random_source.bytes(bytes_drawn_at_once);
  let next_byte_index = 0;

  while (characters.length < secret_length) {
    // Les octets rejetes epuisent la reserve : sans ce retirage, un tirage
    // malchanceux produirait un secret plus court que demande.
    if (next_byte_index >= drawn_bytes.length) {
      drawn_bytes = random_source.bytes(bytes_drawn_at_once);
      next_byte_index = 0;
    }

    const drawn_byte: number = drawn_bytes[next_byte_index] as number;
    next_byte_index += 1;

    if (drawn_byte >= largest_unbiased_byte_value) {
      continue;
    }

    characters.push(alphabet[drawn_byte % alphabet.length] as string);
  }

  return characters.join('');
}
