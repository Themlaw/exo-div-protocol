// Le backend rend des violations NOMMEES plutot que des phrases : c'est lui qui
// decide de ce qui est refuse, et le front qui decide comment le dire. Une
// phrase renvoyee par l'API finirait tot ou tard en anglais dans un formulaire
// francais.
const VIOLATION_MESSAGES: Readonly<Record<string, string>> = {
  malformed_payload: 'Le formulaire n a pas pu etre lu. Rechargez la page et recommencez.',
  title_missing: 'Le titre est obligatoire.',
  no_expected_document: 'Demandez au moins un document.',
  expected_document_label_missing: 'Chaque document doit porter un intitule.',
  expected_document_allowed_mime_types_empty:
    'Chaque document doit autoriser au moins un format.',
  expected_document_max_size_out_of_bounds:
    'La taille maximale doit tenir entre 1 Mo et 20 Mo.',
  max_pin_attempts_out_of_bounds: 'Le nombre d essais de code est hors des bornes autorisees.',
  link_lifetime_days_out_of_bounds: 'La duree de vie du lien est hors des bornes autorisees.',
  pin_length_out_of_bounds: 'La longueur du code est hors des bornes autorisees.',
};

const UNKNOWN_VIOLATION_MESSAGE = 'Cette demande a ete refusee par le serveur.';

export function violation_message(violation: string): string {
  return VIOLATION_MESSAGES[violation] ?? UNKNOWN_VIOLATION_MESSAGE;
}

// Deduplique : deux documents mal libelles produisent deux fois la meme
// violation cote backend, et l'ecrire deux fois a l'ecran ferait croire a deux
// problemes distincts alors que la phrase, elle, est la meme.
export function violation_messages(violations: readonly string[]): readonly string[] {
  return [...new Set(violations.map(violation_message))];
}
