import { NotImplementedError } from './not_implemented';
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
