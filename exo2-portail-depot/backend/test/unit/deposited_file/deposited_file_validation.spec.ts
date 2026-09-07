import { validate_uploaded_file_against_expected_document } from '../../../src/domain/deposited_file';
import { build_deposited_file, build_expected_document } from '../../fixtures/domain_builders';

describe('validate_uploaded_file_against_expected_document', () => {
  it('[28] un type MIME hors de allowed_mime_types est rejete avec mime_type_not_allowed', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
    });
    const file = build_deposited_file({
      declared_mime_type: 'text/plain',
      detected_mime_type: 'text/plain',
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'mime_type_not_allowed',
    );
  });

  it('[28] une taille annoncee au-dessus de max_size_bytes est rejetee avec declared_size_above_limit', () => {
    const expected_document = build_expected_document({ max_size_bytes: 1000 });
    const file = build_deposited_file({
      declared_size_bytes: 1001,
      actual_size_bytes: null,
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'declared_size_above_limit',
    );
  });

  it('[46] une taille reelle au-dessus de la borne est rejetee avec actual_size_above_limit, meme quand la taille annoncee etait conforme : la taille relue sur l\'objet prime sur la taille annoncee par le client', () => {
    const expected_document = build_expected_document({ max_size_bytes: 1000 });
    const file = build_deposited_file({
      declared_size_bytes: 500,
      actual_size_bytes: 1001,
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'actual_size_above_limit',
    );
  });

  it('[29] un detected_mime_type different du declared_mime_type est rejete avec detected_mime_type_mismatch : le Content-Type annonce par le client est declaratif, seul le type reellement detecte fait foi', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'image/jpeg',
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'detected_mime_type_mismatch',
    );
  });

  it('[29 bis] un mensonge sur le Content-Type prime sur un type detecte hors liste blanche : le mensonge merite son propre evenement d\'audit', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/x-msdownload',
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'detected_mime_type_mismatch',
    );
  });

  it('[29 bis] quand le client n\'a pas menti mais que le type detecte n\'est pas autorise, la raison est mime_type_not_allowed', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/x-msdownload',
      detected_mime_type: 'application/x-msdownload',
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'mime_type_not_allowed',
    );
  });

  it('[29 bis] c\'est le type detecte, non le type annonce, qui est confronte a la liste blanche', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['image/jpeg'],
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/pdf',
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBe(
      'mime_type_not_allowed',
    );
  });

  it('un fichier parfaitement conforme n\'est pas rejete', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
      max_size_bytes: 1000,
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/pdf',
      declared_size_bytes: 500,
      actual_size_bytes: 500,
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBeNull();
  });

  it('une taille exactement egale a max_size_bytes est acceptee : la borne est inclusive', () => {
    const expected_document = build_expected_document({
      allowed_mime_types: ['application/pdf', 'image/jpeg'],
      max_size_bytes: 1000,
    });
    const file = build_deposited_file({
      declared_mime_type: 'application/pdf',
      detected_mime_type: 'application/pdf',
      declared_size_bytes: 1000,
      actual_size_bytes: 1000,
    });

    expect(validate_uploaded_file_against_expected_document(expected_document, file)).toBeNull();
  });
});
