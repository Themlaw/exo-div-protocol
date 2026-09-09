import {
  validate_deposit_request_creation,
  type DepositRequestCreationInput,
  type DepositRequestCreationViolation,
} from '../domain/expected_document';
import {
  DEFAULT_SECURITY_POLICY,
  validate_security_policy,
  type SecurityPolicy,
  type SecurityPolicyViolation,
} from '../domain/security_policy';

// `malformed_payload` couvre tout ce qui n'a meme pas la FORME attendue : un
// titre numerique, une liste de documents qui n'en est pas une. On ne peut alors
// rien dire de plus precis sans decrire au client la structure interne qu'on
// attend, et les violations de domaine, elles, supposent des champs bien types.
export type DepositRequestCreationPayloadViolation =
  | DepositRequestCreationViolation
  | SecurityPolicyViolation
  | 'malformed_payload';

export type ParsedDepositRequestCreation =
  | {
      kind: 'valid';
      creation: DepositRequestCreationInput;
      security_policy: SecurityPolicy;
    }
  | { kind: 'invalid'; violations: readonly DepositRequestCreationPayloadViolation[] };

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function read_expected_document(
  value: unknown,
): DepositRequestCreationInput['expected_documents'][number] | null {
  if (!is_plain_object(value)) {
    return null;
  }

  const { label, position, allowed_mime_types, max_size_bytes } = value;

  if (
    typeof label !== 'string' ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(max_size_bytes) ||
    !Array.isArray(allowed_mime_types) ||
    !allowed_mime_types.every((mime_type: unknown): boolean => typeof mime_type === 'string')
  ) {
    return null;
  }

  return {
    label,
    position: position as number,
    allowed_mime_types: allowed_mime_types as string[],
    max_size_bytes: max_size_bytes as number,
  };
}

// La politique est FACULTATIVE : l'avocat qui ne s'en occupe pas doit obtenir
// des valeurs sures, pas une erreur. Fournie, elle est validee cote serveur —
// un parametre de securite regle par le client est un parametre absent.
function read_security_policy(value: unknown): SecurityPolicy | null {
  if (value === undefined) {
    return { ...DEFAULT_SECURITY_POLICY };
  }

  if (!is_plain_object(value)) {
    return null;
  }

  const { max_pin_attempts, link_lifetime_days, pin_length } = value;
  if (
    typeof max_pin_attempts !== 'number' ||
    typeof link_lifetime_days !== 'number' ||
    typeof pin_length !== 'number'
  ) {
    return null;
  }

  return { max_pin_attempts, link_lifetime_days, pin_length };
}

// Le corps arrive d'un client : rien de sa forme n'est acquis. Ce parseur est la
// frontiere ou `unknown` devient un type du domaine, et il n'y en a qu'une.
export function parse_deposit_request_creation(body: unknown): ParsedDepositRequestCreation {
  if (!is_plain_object(body)) {
    return { kind: 'invalid', violations: ['malformed_payload'] };
  }

  const { title, expected_documents, security_policy } = body;
  if (typeof title !== 'string' || !Array.isArray(expected_documents)) {
    return { kind: 'invalid', violations: ['malformed_payload'] };
  }

  const read_documents = expected_documents.map(read_expected_document);
  const submitted_policy: SecurityPolicy | null = read_security_policy(security_policy);
  if (read_documents.includes(null) || submitted_policy === null) {
    return { kind: 'invalid', violations: ['malformed_payload'] };
  }

  const creation: DepositRequestCreationInput = {
    title,
    expected_documents: read_documents as DepositRequestCreationInput['expected_documents'],
  };

  // Les deux validations tournent ensemble, et leurs violations sont rendues
  // d'un bloc : l'avocat corrige son formulaire en une passe au lieu de
  // decouvrir ses erreurs une par une.
  const violations: DepositRequestCreationPayloadViolation[] = [
    ...validate_deposit_request_creation(creation),
    ...validate_security_policy(submitted_policy),
  ];

  if (violations.length > 0) {
    return { kind: 'invalid', violations };
  }

  return { kind: 'valid', creation, security_policy: submitted_policy };
}
