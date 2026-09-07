import type { AccessLink } from '../../src/domain/access_link';
import type { DepositSession } from '../../src/domain/deposit_session';
import type { DepositedFile } from '../../src/domain/deposited_file';
import type { ExpectedDocument } from '../../src/domain/expected_document';

export const REFERENCE_NOW = new Date('2026-03-12T10:00:00.000Z');

// Les identifiants restent lisibles : ils servent a debuguer. En revanche les
// secrets et valeurs derivees prennent leur forme reelle — un HMAC-SHA256 fait
// 64 caracteres hexadecimaux, un hash argon2id porte ses parametres entre `$`.
// Des valeurs lisibles y masqueraient deux classes de defauts : les coincidences
// de sous-chaine (un hash contenant le PIN fait echouer un test de non-fuite sur
// une implementation pourtant correcte) et les hypotheses de forme jamais
// exercees — colonne trop courte, encodage, parsing qui suppose l'absence de `$`.
export const REFERENCE_TOKEN_HMAC =
  '9f2c41ba7e0d5836c1af94e27b6d03518ca7fe20b94d6183ea52c70f4db8916a';

export const REFERENCE_PIN_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdC1mb3ItbGluay0x$K3xQ0hV9mS1pTn7aYcR2wLbE4uJdFgHiOpZvXsNq8Uw';

export function add_days(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function add_minutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function build_access_link(overrides: Partial<AccessLink> = {}): AccessLink {
  return {
    id: 'link-1',
    deposit_request_id: 'request-1',
    token_hmac: REFERENCE_TOKEN_HMAC,
    token_pepper_version: 1,
    pin_hash: REFERENCE_PIN_HASH,
    pin_length: 4,
    max_pin_attempts: 5,
    failed_pin_attempts: 0,
    status: 'active',
    expires_at: add_days(REFERENCE_NOW, 7),
    created_at: REFERENCE_NOW,
    blocked_at: null,
    revoked_at: null,
    ...overrides,
  };
}

export function build_deposit_session(
  overrides: Partial<DepositSession> = {},
): DepositSession {
  return {
    id: 'session-1',
    access_link_id: 'link-1',
    created_at: REFERENCE_NOW,
    expires_at: add_minutes(REFERENCE_NOW, 30),
    ...overrides,
  };
}

export function build_expected_document(
  overrides: Partial<ExpectedDocument> = {},
): ExpectedDocument {
  return {
    id: 'expected-document-1',
    deposit_request_id: 'request-1',
    label: 'Contrat signe',
    position: 1,
    allowed_mime_types: ['application/pdf', 'image/jpeg'],
    max_size_bytes: 20 * 1024 * 1024,
    ...overrides,
  };
}

export function build_deposited_file(
  overrides: Partial<DepositedFile> = {},
): DepositedFile {
  return {
    id: 'file-1',
    expected_document_id: 'expected-document-1',
    access_link_id: 'link-1',
    object_key: 'quarantine/request-1/expected-document-1/upload-1',
    display_filename: 'contrat.pdf',
    declared_mime_type: 'application/pdf',
    detected_mime_type: 'application/pdf',
    declared_size_bytes: 1024,
    actual_size_bytes: 1024,
    status: 'pending_scan',
    created_at: REFERENCE_NOW,
    uploaded_at: REFERENCE_NOW,
    scanned_at: null,
    ...overrides,
  };
}
