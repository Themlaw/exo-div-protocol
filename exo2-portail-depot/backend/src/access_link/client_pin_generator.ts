import type { RandomSource } from '../domain/presigned_upload';
import { draw_unbiased_secret } from '../shared/random_secret';

const PIN_DIGITS = '0123456789';

// Le PIN est le maillon faible du produit, et c'est assume : ce sont le plafond
// d'essais et la limitation qui le tiennent, pas sa longueur. Raison de plus
// pour ne pas lui retirer le peu d'entropie qu'il a par un tirage biaise.
export function generate_client_pin(random_source: RandomSource, pin_length: number): string {
  return draw_unbiased_secret(random_source, PIN_DIGITS, pin_length);
}
