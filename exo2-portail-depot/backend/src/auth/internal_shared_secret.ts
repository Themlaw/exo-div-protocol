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
// Prometheus ne PEUT PAS envoyer un `Authorization` brut : sa configuration de
// collecte impose un schema, et elle refuse explicitement de surcharger cet
// en-tete par un autre moyen. On accepte donc les deux formes — et c'est bien
// l'emetteur qu'on ne peut pas configurer, MinIO, qui garde la sienne.
const BEARER_SCHEME_PREFIX = 'Bearer ';

// Rend `null` pour tout ce qui n'est pas UNE valeur unique : Node rend un
// tableau quand l'en-tete arrive plusieurs fois, et en choisir une laisserait
// un appelant en poser deux, dont une valide, pour brouiller la lecture des
// journaux.
export function read_presented_shared_secret(
  presented_header: string | string[] | undefined,
): string | null {
  if (typeof presented_header !== 'string') {
    return null;
  }

  return presented_header.startsWith(BEARER_SCHEME_PREFIX)
    ? presented_header.slice(BEARER_SCHEME_PREFIX.length)
    : presented_header;
}

export function matches_internal_shared_secret(
  presented_secret: string | undefined,
  expected_secret: string,
): boolean {
  // Un en-tete absent est compare comme une chaine vide plutot que court-circuite :
  // sinon l'absence de secret repondrait plus vite que le mauvais secret.
  return timingSafeEqual(digest_of(presented_secret ?? ''), digest_of(expected_secret));
}
