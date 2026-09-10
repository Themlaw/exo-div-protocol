import { createHash, timingSafeEqual } from 'node:crypto';

// `timingSafeEqual` LEVE quand les deux tampons n'ont pas la meme taille : lui
// donner les secrets bruts ferait fuir la longueur du secret attendu par la
// simple difference entre une reponse et une exception. On compare donc des
// empreintes, qui ont toujours la meme taille, quelle que soit l'entree.
const SECRET_DIGEST_ALGORITHM = 'sha256';

function digest_of(value: string): Buffer {
  return createHash(SECRET_DIGEST_ALGORITHM).update(value, 'utf8').digest();
}

// Neutre quant a l'appelant : le webhook de stockage et le collecteur de
// metriques presentent tous deux un secret partage, et une comparaison en temps
// constant n'a aucune raison d'exister en deux exemplaires.
export function matches_internal_shared_secret(
  presented_secret: string | undefined,
  expected_secret: string,
): boolean {
  // Un en-tete absent est compare comme une chaine vide plutot que court-circuite :
  // sinon l'absence de secret repondrait plus vite que le mauvais secret.
  return timingSafeEqual(digest_of(presented_secret ?? ''), digest_of(expected_secret));
}
