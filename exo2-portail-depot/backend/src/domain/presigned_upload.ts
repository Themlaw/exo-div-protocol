import { NotImplementedError } from './not_implemented';
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
//
// Tirage par REJET plutot que `octet % 62` : 256 n'est pas un multiple de 62,
// et le reste ferait sortir les huit premiers caracteres de l'alphabet un tiers
// plus souvent que les autres. Le biais ne se voit a l'oeil sur aucun token, et
// retire pourtant de l'entropie a chacun d'eux.
const LARGEST_UNBIASED_BYTE_VALUE =
  Math.floor(256 / ACCESS_LINK_TOKEN_ALPHABET.length) * ACCESS_LINK_TOKEN_ALPHABET.length;

// Tire large des le premier appel : demander les octets un par un multiplierait
// les appels au generateur du systeme pour rien.
const RANDOM_BYTES_DRAWN_AT_ONCE = ACCESS_LINK_TOKEN_LENGTH * 2;

export function generate_access_link_token(random_source: RandomSource): string {
  const token_characters: string[] = [];
  let drawn_bytes: Buffer = random_source.bytes(RANDOM_BYTES_DRAWN_AT_ONCE);
  let next_byte_index = 0;

  while (token_characters.length < ACCESS_LINK_TOKEN_LENGTH) {
    // Les octets rejetes epuisent la reserve : il faut pouvoir en retirer,
    // sinon un tirage malchanceux produirait un token trop court.
    if (next_byte_index >= drawn_bytes.length) {
      drawn_bytes = random_source.bytes(RANDOM_BYTES_DRAWN_AT_ONCE);
      next_byte_index = 0;
    }

    const drawn_byte: number = drawn_bytes[next_byte_index] as number;
    next_byte_index += 1;

    if (drawn_byte >= LARGEST_UNBIASED_BYTE_VALUE) {
      continue;
    }

    token_characters.push(
      ACCESS_LINK_TOKEN_ALPHABET[drawn_byte % ACCESS_LINK_TOKEN_ALPHABET.length] as string,
    );
  }

  return token_characters.join('');
}

// La cle est entierement construite par le serveur. Le nom de fichier client
// n'y entre jamais : il est fourni par un tiers non authentifie.
export function build_deposit_object_key(_parameters: {
  deposit_request_id: string;
  expected_document_id: string;
  upload_id: string;
}): string {
  throw new NotImplementedError('build_deposit_object_key');
}

export function sanitize_client_filename_for_display(_filename: string): string {
  throw new NotImplementedError('sanitize_client_filename_for_display');
}

export interface PresignedUploadPolicy {
  bucket: string;
  object_key: string;
  key_prefix: string;
  content_length_range: { min: number; max: number };
  expires_at: Date;
}

export function build_presigned_upload_policy(_parameters: {
  bucket: string;
  object_key: string;
  max_size_bytes: number;
  expires_at: Date;
}): PresignedUploadPolicy {
  throw new NotImplementedError('build_presigned_upload_policy');
}

// Bornee par la session, elle-meme bornee par le lien : la validite la plus courte gagne.
export function compute_presigned_upload_expiry(
  _session: DepositSession,
  _requested_lifetime_seconds: number,
  _now: Date,
): Date {
  throw new NotImplementedError('compute_presigned_upload_expiry');
}
