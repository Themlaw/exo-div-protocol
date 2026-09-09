import { draw_unbiased_secret } from '../shared/random_secret';
import type { DepositSession } from './deposit_session';

export interface RandomSource {
  bytes(length: number): Buffer;
}

export const ACCESS_LINK_TOKEN_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const ACCESS_LINK_TOKEN_LENGTH = 32;

// 32 caracteres sur un alphabet de 62, soit environ 190 bits : le token n'est
// protege par aucun secret que le porteur devrait connaitre, il EST le secret.
// Il doit donc etre hors de portee d'une enumeration, meme distribuee.
export function generate_access_link_token(random_source: RandomSource): string {
  return draw_unbiased_secret(
    random_source,
    ACCESS_LINK_TOKEN_ALPHABET,
    ACCESS_LINK_TOKEN_LENGTH,
  );
}

// La cle est entierement construite par le serveur. Le nom de fichier client
// n'y entre jamais : il est fourni par un tiers non authentifie.
export function build_deposit_object_key(parameters: {
  deposit_request_id: string;
  expected_document_id: string;
  upload_id: string;
}): string {
  return [
    parameters.deposit_request_id,
    parameters.expected_document_id,
    parameters.upload_id,
  ].join('/');
}

// Le nom affiche est BORNE en longueur : il finira dans une page, un journal et
// une notification, et un nom de 300 caracteres y casse tout ce qui l'affiche.
const MAXIMUM_DISPLAY_FILENAME_LENGTH = 120;

// Un nom vide, ou vide une fois nettoye, doit rester exploitable : une chaine
// vide dans une liste de pieces ne se clique pas et ne se nomme pas.
const FALLBACK_DISPLAY_FILENAME = 'document';

// Ce nom vient d'un tiers non authentifie et n'entre JAMAIS dans la cle de
// l'objet : il ne sert qu'a l'affichage. Il est malgre tout nettoye, parce
// qu'il sera rendu dans une page et dans un en-tete Content-Disposition.
export function sanitize_client_filename_for_display(filename: string): string {
  // Le dernier segment seulement : `../../etc/passwd` devient `passwd`, et
  // aucune remontee de chemin ne survit a l'operation.
  const last_path_segment: string = filename.split(/[/\\]/).at(-1) ?? '';

  const sanitized: string = last_path_segment
    // Tout ce qui n'est pas une lettre, un chiffre, un point, un tiret ou un
    // souligne devient un souligne : espaces, octets nuls et caracteres de
    // controle compris, sans avoir a les enumerer.
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // Les points consecutifs s'effondrent en un seul : c'est ce qui interdit
    // qu'un `..` reapparaisse apres le nettoyage.
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, MAXIMUM_DISPLAY_FILENAME_LENGTH);

  return sanitized.length > 0 ? sanitized : FALLBACK_DISPLAY_FILENAME;
}

export interface PresignedUploadPolicy {
  bucket: string;
  object_key: string;
  key_prefix: string;
  content_length_range: { min: number; max: number };
  expires_at: Date;
}

// Un objet de zero octet n'est jamais un depot : c'est un formulaire envoye
// sans fichier, ou un transfert interrompu. L'accepter creerait une piece qui
// occupe un emplacement sans rien contenir.
const MINIMUM_UPLOAD_SIZE_BYTES = 1;

// La policy EST la barriere serveur du presigned : une fois signee, MinIO ne
// verifie plus rien d'autre. Ce qui n'est pas ecrit ici n'est contraint nulle
// part.
export function build_presigned_upload_policy(parameters: {
  bucket: string;
  object_key: string;
  max_size_bytes: number;
  expires_at: Date;
}): PresignedUploadPolicy {
  return {
    bucket: parameters.bucket,
    object_key: parameters.object_key,
    // Le prefixe est le dossier de la cle, jamais la cle entiere : il borne ce
    // que le porteur de la policy peut ecrire a l'emplacement qu'on lui a
    // ouvert, sans l'autoriser a viser le dossier d'un autre.
    key_prefix: parameters.object_key.slice(0, parameters.object_key.lastIndexOf('/') + 1),
    content_length_range: { min: MINIMUM_UPLOAD_SIZE_BYTES, max: parameters.max_size_bytes },
    expires_at: parameters.expires_at,
  };
}

// Bornee par la session, elle-meme bornee par le lien : la validite la plus courte gagne.
export function compute_presigned_upload_expiry(
  session: DepositSession,
  requested_lifetime_seconds: number,
  now: Date,
): Date {
  const requested_expiry: number = now.getTime() + requested_lifetime_seconds * 1000;

  return new Date(Math.min(requested_expiry, session.expires_at.getTime()));
}
