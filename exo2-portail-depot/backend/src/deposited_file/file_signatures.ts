// La liste des formats que le portail sait reconnaitre, et leurs signatures.
//
// Elle est la source de verite de `detected_mime_type`, celui qui fait foi face
// a la liste blanche du document attendu. Un format absent d'ici est INCONNU,
// donc rejete : la liste est une autorisation, jamais une documentation.
//
// Les octets sont lus sur l'objet reellement stocke, jamais sur ce que le
// client a annonce. Voir [[statuts-et-depot]] et [[upload-securite-fichiers]].

// Ce qu'on relit sur l'objet pour decider. Quatre kilooctets : les signatures
// utiles tiennent dans les premiers octets, sauf les formats ZIP dont on doit
// aller lire un nom de partie un peu plus loin.
export const DETECTION_PREFIX_BYTES = 4096;

interface FileSignature {
  mime_type: string;
  matches(prefix: Buffer): boolean;
}

function starts_with(prefix: Buffer, magic_bytes: readonly number[], offset = 0): boolean {
  if (prefix.length < offset + magic_bytes.length) {
    return false;
  }
  return magic_bytes.every((byte: number, index: number): boolean => prefix[offset + index] === byte);
}

function has_ascii_at(prefix: Buffer, text: string, offset: number): boolean {
  return starts_with(prefix, [...Buffer.from(text, 'ascii')], offset);
}

// Les formats de la famille ISOBMFF — HEIC, HEIF, AVIF — portent tous `ftyp` au
// meme endroit et ne se distinguent que par leur marque. Les enumerer une par
// une plutot que de se fier a la seule presence de `ftyp` : un MP4 la porte
// aussi, et le prendre pour une photo laisserait passer une video.
const ISOBMFF_BRAND_OFFSET = 8;

function has_isobmff_brand(prefix: Buffer, brands: readonly string[]): boolean {
  return (
    has_ascii_at(prefix, 'ftyp', 4) &&
    brands.some((brand: string): boolean => has_ascii_at(prefix, brand, ISOBMFF_BRAND_OFFSET))
  );
}

// Un conteneur ZIP. Il ne dit rien a lui seul : docx, xlsx, odt et une archive
// quelconque commencent tous pareil.
function is_zip_container(prefix: Buffer): boolean {
  return starts_with(prefix, [0x50, 0x4b, 0x03, 0x04]);
}

// OpenDocument ecrit une entree `mimetype` NON COMPRESSEE en tete d'archive,
// precisement pour etre reconnaissable sans decompresser. Sa valeur suit
// immediatement l'en-tete local, a l'octet 38.
const OPENDOCUMENT_MIME_TYPE_OFFSET = 38;

function is_opendocument_of_type(prefix: Buffer, mime_type: string): boolean {
  return (
    is_zip_container(prefix) &&
    has_ascii_at(prefix, 'mimetype', 30) &&
    has_ascii_at(prefix, mime_type, OPENDOCUMENT_MIME_TYPE_OFFSET)
  );
}

// OOXML n'offre pas ce raccourci : distinguer un .docx d'un .xlsx demanderait de
// lire le catalogue de l'archive. On cherche donc le nom de dossier propre a
// chaque famille dans le debut du fichier — heuristique assumee, et documentee
// comme telle. Elle ne peut pas rendre un faux positif dangereux : au pire elle
// ne reconnait rien, et la piece est rejetee.
function is_ooxml_of_family(prefix: Buffer, part_directory: string): boolean {
  return is_zip_container(prefix) && prefix.includes(Buffer.from(part_directory, 'ascii'));
}

// L'ordre compte : les regles les plus specifiques d'abord, les conteneurs
// ensuite. Un .docx est un ZIP, et le reconnaitre comme archive serait vrai
// mais inutile.
const FILE_SIGNATURES: readonly FileSignature[] = [
  { mime_type: 'application/pdf', matches: (prefix) => has_ascii_at(prefix, '%PDF-', 0) },

  // --- Images ---
  {
    mime_type: 'image/png',
    matches: (prefix) => starts_with(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime_type: 'image/jpeg', matches: (prefix) => starts_with(prefix, [0xff, 0xd8, 0xff]) },
  {
    mime_type: 'image/gif',
    matches: (prefix) => has_ascii_at(prefix, 'GIF87a', 0) || has_ascii_at(prefix, 'GIF89a', 0),
  },
  { mime_type: 'image/bmp', matches: (prefix) => has_ascii_at(prefix, 'BM', 0) },
  {
    mime_type: 'image/tiff',
    matches: (prefix) =>
      starts_with(prefix, [0x49, 0x49, 0x2a, 0x00]) || starts_with(prefix, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    mime_type: 'image/webp',
    matches: (prefix) => has_ascii_at(prefix, 'RIFF', 0) && has_ascii_at(prefix, 'WEBP', 8),
  },
  {
    mime_type: 'image/avif',
    matches: (prefix) => has_isobmff_brand(prefix, ['avif', 'avis']),
  },
  {
    // Le format des photos d'iPhone, donc celui qui arrivera le plus souvent
    // d'un client qui prend son document en photo. L'oublier ferait rejeter le
    // depot le plus courant du produit.
    mime_type: 'image/heic',
    matches: (prefix) => has_isobmff_brand(prefix, ['heic', 'heix', 'hevc', 'hevx']),
  },
  {
    mime_type: 'image/heif',
    matches: (prefix) => has_isobmff_brand(prefix, ['mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']),
  },

  // --- Bureautique ouverte ---
  {
    mime_type: 'application/vnd.oasis.opendocument.text',
    matches: (prefix) =>
      is_opendocument_of_type(prefix, 'application/vnd.oasis.opendocument.text'),
  },
  {
    mime_type: 'application/vnd.oasis.opendocument.spreadsheet',
    matches: (prefix) =>
      is_opendocument_of_type(prefix, 'application/vnd.oasis.opendocument.spreadsheet'),
  },
  {
    mime_type: 'application/vnd.oasis.opendocument.presentation',
    matches: (prefix) =>
      is_opendocument_of_type(prefix, 'application/vnd.oasis.opendocument.presentation'),
  },

  // --- Bureautique Microsoft ---
  {
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (prefix) => is_ooxml_of_family(prefix, 'word/'),
  },
  {
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: (prefix) => is_ooxml_of_family(prefix, 'xl/'),
  },
  {
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    matches: (prefix) => is_ooxml_of_family(prefix, 'ppt/'),
  },
];

// Les types que l'avocat peut inscrire dans une liste blanche. Ce sont
// exactement ceux qu'on sait reconnaitre : proposer un type indetectable
// reviendrait a promettre un depot que le scan rejetterait ensuite.
export const DETECTABLE_MIME_TYPES: readonly string[] = FILE_SIGNATURES.map(
  (signature: FileSignature): string => signature.mime_type,
);

// `null` pour tout ce qui n'est pas reconnu, y compris un fichier vide ou
// tronque. C'est un REJET, jamais une acceptation par defaut : on ne laisse pas
// passer ce qu'on n'a pas su nommer.
export function detect_mime_type_from_prefix(prefix: Buffer): string | null {
  return (
    FILE_SIGNATURES.find((signature: FileSignature): boolean => signature.matches(prefix))
      ?.mime_type ?? null
  );
}
