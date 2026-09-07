import { NotImplementedError } from './not_implemented';

// Plafond de la plateforme. L'avocat peut resserrer par document, jamais depasser.
// Une limite par type de fichier a ete ecartee : un PDF scanne pese autant qu'une
// image, le type est un mauvais indicateur de taille.
export const EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS = {
  min: 1024,
  max: 20 * 1024 * 1024,
} as const;

export interface ExpectedDocument {
  id: string;
  deposit_request_id: string;
  label: string;
  position: number;
  allowed_mime_types: string[];
  max_size_bytes: number;
}

export interface DepositRequestCreationInput {
  title: string;
  expected_documents: Omit<ExpectedDocument, 'id' | 'deposit_request_id'>[];
}

export type DepositRequestCreationViolation =
  | 'title_missing'
  | 'no_expected_document'
  | 'expected_document_label_missing'
  | 'expected_document_allowed_mime_types_empty'
  | 'expected_document_max_size_out_of_bounds';

export function validate_deposit_request_creation(
  _input: DepositRequestCreationInput,
): DepositRequestCreationViolation[] {
  throw new NotImplementedError('validate_deposit_request_creation');
}
