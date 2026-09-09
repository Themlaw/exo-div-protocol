import type { RandomSource } from '../domain/presigned_upload';

const PIN_DIGIT_COUNT = 10;

// Tirage par REJET, comme pour le token : 256 n'est pas un multiple de 10, et
// `octet % 10` sortirait les chiffres 0 a 5 plus souvent que 6 a 9. Sur six
// chiffres, c'est retirer de l'entropie la ou il y en a deja tres peu — et le
// PIN est deja le maillon faible, tenu par le plafond d'essais et non par sa
// longueur.
export const MAXIMUM_UNBIASED_PIN_BYTE_VALUE = Math.floor(256 / PIN_DIGIT_COUNT) * PIN_DIGIT_COUNT;

// Tire large des le premier appel : demander les octets un par un multiplierait
// les appels au generateur du systeme pour rien.
const RANDOM_BYTES_DRAWN_AT_ONCE = 32;

export function generate_client_pin(random_source: RandomSource, pin_length: number): string {
  const digits: string[] = [];
  let drawn_bytes: Buffer = random_source.bytes(RANDOM_BYTES_DRAWN_AT_ONCE);
  let next_byte_index = 0;

  while (digits.length < pin_length) {
    // Les octets rejetes epuisent la reserve : sans ce retirage, un tirage
    // malchanceux produirait un PIN plus court que la politique ne l'exige.
    if (next_byte_index >= drawn_bytes.length) {
      drawn_bytes = random_source.bytes(RANDOM_BYTES_DRAWN_AT_ONCE);
      next_byte_index = 0;
    }

    const drawn_byte: number = drawn_bytes[next_byte_index] as number;
    next_byte_index += 1;

    if (drawn_byte >= MAXIMUM_UNBIASED_PIN_BYTE_VALUE) {
      continue;
    }

    digits.push(String(drawn_byte % PIN_DIGIT_COUNT));
  }

  return digits.join('');
}
