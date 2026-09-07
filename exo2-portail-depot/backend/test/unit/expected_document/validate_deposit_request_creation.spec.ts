import { validate_deposit_request_creation } from '../../../src/domain/expected_document';
import { EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS } from '../../../src/domain/expected_document';
import type { DepositRequestCreationInput } from '../../../src/domain/expected_document';
import { build_expected_document } from '../../../test/fixtures/domain_builders';

function to_expected_document_input(
  overrides: Parameters<typeof build_expected_document>[0] = {},
): DepositRequestCreationInput['expected_documents'][number] {
  const { id: _id, deposit_request_id: _deposit_request_id, ...rest } =
    build_expected_document(overrides);
  return rest;
}

describe('validate_deposit_request_creation', () => {
  it('[32] signale no_expected_document pour une demande sans aucun document attendu', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [],
    };

    expect(validate_deposit_request_creation(input)).toContain(
      'no_expected_document',
    );
  });

  it('[32] signale title_missing pour un titre vide', () => {
    const input: DepositRequestCreationInput = {
      title: '',
      expected_documents: [to_expected_document_input()],
    };

    expect(validate_deposit_request_creation(input)).toContain('title_missing');
  });

  it('[32] signale expected_document_label_missing pour un document attendu sans libellé', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [to_expected_document_input({ label: '' })],
    };

    expect(validate_deposit_request_creation(input)).toContain(
      'expected_document_label_missing',
    );
  });

  it('[32] signale expected_document_allowed_mime_types_empty pour une liste de formats autorisés vide', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [to_expected_document_input({ allowed_mime_types: [] })],
    };

    expect(validate_deposit_request_creation(input)).toContain(
      'expected_document_allowed_mime_types_empty',
    );
  });

  it('[32] ne produit aucune violation pour une demande valide', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [to_expected_document_input()],
    };

    expect(validate_deposit_request_creation(input)).toEqual([]);
  });

  it('[32] signale expected_document_max_size_out_of_bounds au-dessus du plafond : l\'avocat peut resserrer la limite par document, jamais depasser le plafond de la plateforme', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [
        to_expected_document_input({
          max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.max + 1,
        }),
      ],
    };

    expect(validate_deposit_request_creation(input)).toContain(
      'expected_document_max_size_out_of_bounds',
    );
  });

  it('[32] signale expected_document_max_size_out_of_bounds en dessous du minimum', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [
        to_expected_document_input({
          max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.min - 1,
        }),
      ],
    };

    expect(validate_deposit_request_creation(input)).toContain(
      'expected_document_max_size_out_of_bounds',
    );
  });

  it('[32] accepte les valeurs exactement egales au minimum et au maximum : les bornes sont inclusives', () => {
    const input_at_min: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [
        to_expected_document_input({
          max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.min,
        }),
      ],
    };
    const input_at_max: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [
        to_expected_document_input({
          max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.max,
        }),
      ],
    };

    expect(validate_deposit_request_creation(input_at_min)).not.toContain(
      'expected_document_max_size_out_of_bounds',
    );
    expect(validate_deposit_request_creation(input_at_max)).not.toContain(
      'expected_document_max_size_out_of_bounds',
    );
  });

  it('[32] accepte une limite intermediaire resserree par l\'avocat, plus basse que le plafond : cas d\'usage normal', () => {
    const input: DepositRequestCreationInput = {
      title: 'Dossier de succession',
      expected_documents: [
        to_expected_document_input({
          max_size_bytes: EXPECTED_DOCUMENT_MAX_SIZE_BOUNDS.min + 1,
        }),
      ],
    };

    expect(validate_deposit_request_creation(input)).not.toContain(
      'expected_document_max_size_out_of_bounds',
    );
  });
});
