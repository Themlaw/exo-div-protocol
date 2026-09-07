import {
  apply_scan_verdict_to_deposited_file,
  is_deposited_file_scan_overdue,
  reset_deposited_file_after_new_object_arrival,
} from '../../../src/domain/deposited_file';
import {
  REFERENCE_NOW,
  add_minutes,
  build_deposited_file,
} from '../../fixtures/domain_builders';

describe('apply_scan_verdict_to_deposited_file', () => {
  it('[47] un verdict scanner_unavailable laisse le fichier en pending_scan, scanned_at reste null, aucun passage a clean n\'est possible sans verdict', () => {
    const file = build_deposited_file({ status: 'pending_scan', scanned_at: null });
    const now = REFERENCE_NOW;

    const outcome = apply_scan_verdict_to_deposited_file(file, 'scanner_unavailable', now);

    expect(outcome.file_after_verdict.status).toBe('pending_scan');
    expect(outcome.file_after_verdict.scanned_at).toBeNull();
    expect(outcome.must_delete_stored_object).toBe(false);
  });

  it('un verdict clean fait passer le fichier a clean, scanned_at est renseigne depuis l\'horloge injectee', () => {
    const file = build_deposited_file({ status: 'pending_scan', scanned_at: null });
    const now = REFERENCE_NOW;

    const outcome = apply_scan_verdict_to_deposited_file(file, 'clean', now);

    expect(outcome.file_after_verdict.status).toBe('clean');
    expect(outcome.file_after_verdict.scanned_at).toEqual(REFERENCE_NOW);
  });

  it('[49] un verdict infected fait passer le fichier a infected et impose la suppression de l\'objet stocke : il doit quitter le bucket de quarantaine', () => {
    const file = build_deposited_file({ status: 'pending_scan', scanned_at: null });
    const now = REFERENCE_NOW;

    const outcome = apply_scan_verdict_to_deposited_file(file, 'infected', now);

    expect(outcome.file_after_verdict.status).toBe('infected');
    expect(outcome.must_delete_stored_object).toBe(true);
  });

  // La fonction ne recoit volontairement ni lien ni statut de demande : un lien expire,
  // bloque ou revoque n'est jamais une raison de laisser un virus dans le bucket de quarantaine.
  it.each([
    { status: 'pending_scan' as const, scanned_at: null },
    { status: 'clean' as const, scanned_at: REFERENCE_NOW },
  ])(
    '[49] un verdict infected impose must_delete_stored_object a true quel que soit l\'etat de depart du fichier ($status)',
    ({ status, scanned_at }) => {
      const file = build_deposited_file({ status, scanned_at });
      const now = REFERENCE_NOW;

      const outcome = apply_scan_verdict_to_deposited_file(file, 'infected', now);

      expect(outcome.must_delete_stored_object).toBe(true);
    },
  );
});

describe('is_deposited_file_scan_overdue', () => {
  it('[48] un fichier pending_scan plus vieux que le seuil est en retard', () => {
    const file = build_deposited_file({
      status: 'pending_scan',
      uploaded_at: add_minutes(REFERENCE_NOW, -30),
    });
    const now = REFERENCE_NOW;

    expect(is_deposited_file_scan_overdue(file, 15, now)).toBe(true);
  });

  it('[48] un fichier pending_scan recent n\'est pas en retard', () => {
    const file = build_deposited_file({
      status: 'pending_scan',
      uploaded_at: add_minutes(REFERENCE_NOW, -5),
    });
    const now = REFERENCE_NOW;

    expect(is_deposited_file_scan_overdue(file, 15, now)).toBe(false);
  });

  it('[48] un fichier deja clean n\'est jamais en retard quel que soit son age', () => {
    const file = build_deposited_file({
      status: 'clean',
      uploaded_at: add_minutes(REFERENCE_NOW, -1000),
      scanned_at: add_minutes(REFERENCE_NOW, -999),
    });
    const now = REFERENCE_NOW;

    expect(is_deposited_file_scan_overdue(file, 15, now)).toBe(false);
  });
});

describe('reset_deposited_file_after_new_object_arrival', () => {
  it('[52] un fichier clean qui recoit un nouvel objet retombe en pending_scan, son scanned_at et son detected_mime_type sont remis a null : sans cette remise a zero un fichier sain remplace apres coup heriterait de sa validation (TOCTOU)', () => {
    const file = build_deposited_file({
      status: 'clean',
      scanned_at: REFERENCE_NOW,
      detected_mime_type: 'application/pdf',
    });
    const now = add_minutes(REFERENCE_NOW, 5);

    const reset_file = reset_deposited_file_after_new_object_arrival(file, now);

    expect(reset_file.status).toBe('pending_scan');
    expect(reset_file.scanned_at).toBeNull();
    expect(reset_file.detected_mime_type).toBeNull();
  });

  it('[52 bis] le meme reset applique a un fichier infected le ramene aussi en pending_scan', () => {
    const file = build_deposited_file({
      status: 'infected',
      scanned_at: REFERENCE_NOW,
      detected_mime_type: 'application/x-msdownload',
    });
    const now = add_minutes(REFERENCE_NOW, 5);

    const reset_file = reset_deposited_file_after_new_object_arrival(file, now);

    expect(reset_file.status).toBe('pending_scan');
    expect(reset_file.scanned_at).toBeNull();
    expect(reset_file.detected_mime_type).toBeNull();
  });
});
