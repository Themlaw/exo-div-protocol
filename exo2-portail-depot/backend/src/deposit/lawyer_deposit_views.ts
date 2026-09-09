import type { DepositedFile, DepositedFileStatus } from '../domain/deposited_file';
import type { ExpectedDocument } from '../domain/expected_document';

// La piece telle que l'avocat la voit. Ni `object_key` — un secret
// d'infrastructure qui offrirait une cible nommee a qui obtiendrait un acces au
// stockage — ni `access_link_id`, qui ne lui apprend rien sur son dossier.
export interface LawyerDepositedFileView {
  id: string;
  display_filename: string;
  declared_mime_type: string;
  // La taille MESUREE, et null tant qu'elle est inconnue. La taille annoncee
  // n'est qu'une declaration du client : l'afficher comme un poids reel ferait
  // croire a une verification qui n'a pas eu lieu.
  size_bytes: number | null;
  status: DepositedFileStatus;
  uploaded_at: Date | null;
  scanned_at: Date | null;
}

export interface LawyerExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: string[];
  max_size_bytes: number;
  deposited_file: LawyerDepositedFileView | null;
}

function to_lawyer_deposited_file_view(file: DepositedFile): LawyerDepositedFileView {
  return {
    id: file.id,
    display_filename: file.display_filename,
    declared_mime_type: file.declared_mime_type,
    size_bytes: file.actual_size_bytes,
    status: file.status,
    uploaded_at: file.uploaded_at,
    scanned_at: file.scanned_at,
  };
}

// Un emplacement peut avoir porte plusieurs pieces dans le temps : une piece
// refusee, puis une nouvelle tentative. C'est la DERNIERE qui dit ou en est
// l'emplacement aujourd'hui, et c'est donc elle que l'avocat voit.
export function build_lawyer_expected_document_views(
  expected_documents: readonly ExpectedDocument[],
  deposited_files: readonly DepositedFile[],
): LawyerExpectedDocumentView[] {
  const latest_file_by_expected_document = new Map<string, DepositedFile>();

  for (const file of deposited_files) {
    const known: DepositedFile | undefined = latest_file_by_expected_document.get(
      file.expected_document_id,
    );

    if (known === undefined || known.created_at.getTime() < file.created_at.getTime()) {
      latest_file_by_expected_document.set(file.expected_document_id, file);
    }
  }

  return [...expected_documents]
    // L'ordre est celui que l'avocat a donne a son formulaire : le rendre dans
    // l'ordre d'insertion en base ferait bouger sa liste d'un chargement a
    // l'autre.
    .sort(
      (left: ExpectedDocument, right: ExpectedDocument): number => left.position - right.position,
    )
    .map((expected_document: ExpectedDocument): LawyerExpectedDocumentView => {
      const file: DepositedFile | undefined = latest_file_by_expected_document.get(
        expected_document.id,
      );

      return {
        id: expected_document.id,
        label: expected_document.label,
        position: expected_document.position,
        allowed_mime_types: expected_document.allowed_mime_types,
        max_size_bytes: expected_document.max_size_bytes,
        deposited_file: file === undefined ? null : to_lawyer_deposited_file_view(file),
      };
    });
}
