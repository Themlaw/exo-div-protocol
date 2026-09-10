import type { PublicAccessLinkState } from '../domain/access_link';
import type { DepositRequestStatus } from '../domain/deposit_request_status';
import type { DepositedFileStatus } from '../domain/deposited_file';

// Les formes rendues au CLIENT anonyme. Extraites du controleur pour qu'elles
// soient nommables ailleurs : le front en derive ses propres contrats, et un
// test de derive compare les deux. Des interfaces internes a un controleur ne
// pouvaient pas etre comparees a quoi que ce soit.

// Ce que le client a le droit de savoir AVANT le PIN : l'etat, et la longueur
// du code pour dessiner la saisie. Ni titre, ni nombre de pieces, ni nom de
// dossier — la longueur, elle, est deja sous les yeux du destinataire legitime
// dans le message qu'il a recu.
export interface PublicAccessLinkView {
  state: PublicAccessLinkState;
  pin_length?: number;
}

// Ce que le client voit une fois le PIN passe. Le titre apparait ICI et pas
// avant : sur la page d'accueil du lien il serait une fuite, derriere le PIN il
// est ce qui permet de savoir quel dossier on ouvre.
export interface ClientDepositBoardView {
  title: string;
  deposit_request_status: DepositRequestStatus;
  session_expires_at: string;
  expected_documents: readonly ClientExpectedDocumentView[];
}

export interface ClientExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: readonly string[];
  max_size_bytes: number;
  // `null` tant que l'emplacement est libre. Seule la piece qui l'OCCUPE est
  // rendue : une reservation dont l'objet n'est jamais arrive ne doit pas
  // s'afficher comme un depot reussi.
  deposited_file: ClientDepositedFileView | null;
}

export interface ClientDepositedFileView {
  id: string;
  display_filename: string;
  // L'enumeration fermee, et non `string` : c'est ce statut qui choisit la
  // pastille cote front, et un `string` l'obligerait a prevoir un cas par
  // defaut pour une valeur qui ne peut pas exister.
  status: DepositedFileStatus;
}

// Ce que le navigateur poste ensuite, tel quel, vers MinIO.
export interface ClientUploadTicketView {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Readonly<Record<string, string>>;
  expires_at: string;
}
