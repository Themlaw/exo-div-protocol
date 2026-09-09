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

// Rend TOUTES les violations, jamais la premiere : l'avocat qui remplit un
// formulaire de dix documents corrige en une passe au lieu de decouvrir ses
// erreurs une par une. Meme raison que pour l'amorcage du compte de demo.
//
// Les violations ne sont pas dedupliquees a l'echelle du document : deux
// documents mal libelles produisent deux `expected_document_label_missing`.
// C'est ce qui permettra a l'appelant de compter, et une liste dedupliquee
// ferait croire a une seule erreur.
export function validate_deposit_request_creation(
  input: DepositRequestCreationInput,
): DepositRequestCreationViolation[] {
  const violations: DepositRequestCreationViolation[] = [];

  // Un titre fait d'espaces n'est pas un titre : il s'afficherait comme une
  // ligne vide dans « Mes demandes », sans que rien ne l'ait signale.
  if (input.title.trim().length === 0) {
    violations.push('title_missing');
  }

  // Une demande sans document attendu produirait un lien que le client ouvre
  // pour n'y rien trouver a deposer.
  if (input.expected_documents.length === 0) {
    violations.push('no_expected_document');
  }

  for (const expected_document of input.expected_documents) {
    if (expected_document.label.trim().length === 0) {
      violations.push('expected_document_label_missing');
    }

    // Une liste blanche vide n'autorise rien : le document serait impossible a
    // deposer. C'est le cas ou la validation cote serveur compte le plus, car
    // un formulaire peut parfaitement l'omettre sans que cela se voie.
    if (expected_document.allowed_mime_types.length === 0) {
      violations.push('expected_document_allowed_mime_types_empty');
    }

    // Bornes INCLUSIVES des deux cotes : l'avocat resserre en dessous du
    // plafond de la plateforme, jamais au-dessus.
    if (
      expected_document.max_size_bytes < EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.min ||
      expected_document.max_size_bytes > EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.max
    ) {
      violations.push('expected_document_max_size_out_of_bounds');
    }
  }

  return violations;
}
