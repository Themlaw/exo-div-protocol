import {
  does_deposited_file_occupy_expected_document,
  plan_deposited_file_removal,
  should_invalidate_deposited_file_after_expected_document_change,
  type DepositedFileStatus,
} from '../../../src/domain/deposited_file';
import { build_deposited_file, build_expected_document } from '../../fixtures/domain_builders';

describe('does_deposited_file_occupy_expected_document', () => {
  it.each<DepositedFileStatus>(['pending_scan', 'clean'])(
    "[25/73] un fichier '%s' occupe l'emplacement",
    (status) => {
      const file = build_deposited_file({ status });

      expect(does_deposited_file_occupy_expected_document(file)).toBe(true);
    },
  );

  it.each<DepositedFileStatus>(['pending_upload', 'rejected', 'infected'])(
    "[25/73] un fichier '%s' n'occupe pas l'emplacement : un upload rate ne doit pas condamner definitivement l'emplacement",
    (status) => {
      const file = build_deposited_file({ status });

      expect(does_deposited_file_occupy_expected_document(file)).toBe(false);
    },
  );
});

describe('plan_deposited_file_removal', () => {
  it('[26/66] quand la demande est incomplete, la suppression est autorisee et l\'objet doit reellement quitter le bucket : la ligne en base ne suffit pas', () => {
    const file = build_deposited_file({ status: 'clean' });

    const plan = plan_deposited_file_removal(file, 'incomplete');

    expect(plan.allowed).toBe(true);
    expect(plan.must_delete_stored_object).toBe(true);
  });

  it('[27] quand la demande est processing, la suppression est refusee', () => {
    const file = build_deposited_file({ status: 'clean' });

    const plan = plan_deposited_file_removal(file, 'processing');

    expect(plan.allowed).toBe(false);
  });

  it('quand la demande est validated, la suppression est refusee', () => {
    const file = build_deposited_file({ status: 'clean' });

    const plan = plan_deposited_file_removal(file, 'validated');

    expect(plan.allowed).toBe(false);
  });

  it('un fichier encore pending_upload n\'a pas d\'objet a supprimer', () => {
    const file = build_deposited_file({ status: 'pending_upload' });

    const plan = plan_deposited_file_removal(file, 'incomplete');

    expect(plan.must_delete_stored_object).toBe(false);
  });
});

describe('should_invalidate_deposited_file_after_expected_document_change', () => {
  it('[72] retirer image/jpeg des formats autorises invalide un fichier deja depose en JPEG', () => {
    const expected_document_after_change = build_expected_document({
      allowed_mime_types: ['application/pdf'],
    });
    const file = build_deposited_file({
      status: 'clean',
      declared_mime_type: 'image/jpeg',
      detected_mime_type: 'image/jpeg',
    });

    expect(
      should_invalidate_deposited_file_after_expected_document_change(
        expected_document_after_change,
        file,
      ),
    ).toBe(true);
  });

  it('[72] un fichier PDF n\'est pas affecte par le retrait du format JPEG', () => {
    const expected_document_after_change = build_expected_document({
      allowed_mime_types: ['application/pdf'],
    });
    const file = build_deposited_file({
      status: 'clean',
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/pdf',
    });

    expect(
      should_invalidate_deposited_file_after_expected_document_change(
        expected_document_after_change,
        file,
      ),
    ).toBe(false);
  });

  it('[72] reduire max_size_bytes en dessous de la taille d\'un fichier deja depose l\'invalide aussi', () => {
    const expected_document_after_change = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
      max_size_bytes: 500,
    });
    const file = build_deposited_file({
      status: 'clean',
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/pdf',
      declared_size_bytes: 1000,
      actual_size_bytes: 1000,
    });

    expect(
      should_invalidate_deposited_file_after_expected_document_change(
        expected_document_after_change,
        file,
      ),
    ).toBe(true);
  });
});
