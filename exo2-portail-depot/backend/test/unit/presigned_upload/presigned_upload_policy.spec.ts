import { build_presigned_upload_policy } from '../../../src/domain/presigned_upload';
import { add_minutes, REFERENCE_NOW } from '../../fixtures/domain_builders';

describe('build_presigned_upload_policy', () => {
  it('[67] content_length_range.max vaut max_size_bytes et key_prefix est dérivé de object_key : seule barrière serveur du presigned', () => {
    const object_key = 'quarantine/request-1/expected-document-1/upload-1';

    const policy = build_presigned_upload_policy({
      bucket: 'quarantine-bucket',
      object_key,
      max_size_bytes: 20 * 1024 * 1024,
      expires_at: add_minutes(REFERENCE_NOW, 10),
    });

    expect(policy.content_length_range.max).toBe(20 * 1024 * 1024);
    expect(object_key.startsWith(policy.key_prefix)).toBe(true);
  });

  it('content_length_range.min est strictement positif : un objet de 0 octet ne doit jamais être autorisé', () => {
    const policy = build_presigned_upload_policy({
      bucket: 'quarantine-bucket',
      object_key: 'quarantine/request-1/expected-document-1/upload-1',
      max_size_bytes: 1024,
      expires_at: add_minutes(REFERENCE_NOW, 10),
    });

    expect(policy.content_length_range.min).toBeGreaterThan(0);
  });

  it('expires_at est reporté tel quel dans la policy', () => {
    const expires_at = add_minutes(REFERENCE_NOW, 15);

    const policy = build_presigned_upload_policy({
      bucket: 'quarantine-bucket',
      object_key: 'quarantine/request-1/expected-document-1/upload-1',
      max_size_bytes: 1024,
      expires_at,
    });

    expect(policy.expires_at).toEqual(expires_at);
  });

  it('le bucket de la policy est bien celui passé en paramètre', () => {
    const policy = build_presigned_upload_policy({
      bucket: 'quarantine-bucket',
      object_key: 'quarantine/request-1/expected-document-1/upload-1',
      max_size_bytes: 1024,
      expires_at: add_minutes(REFERENCE_NOW, 10),
    });

    expect(policy.bucket).toBe('quarantine-bucket');
  });
});
