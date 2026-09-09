import { parse_minio_connection_settings } from '../../../src/object_storage/minio_object_storage';

describe('parse_minio_connection_settings', () => {
  it('deduit le TLS du schema plutot que d une variable separee', () => {
    const settings = parse_minio_connection_settings({
      endpoint_url: 'https://stockage.exemple.fr',
      access_key: 'cle',
      secret_key: 'secret',
    });

    expect(settings).toMatchObject({ endPoint: 'stockage.exemple.fr', useSSL: true, port: 443 });
  });

  it('un endpoint sans port explicite retombe sur le port du schema', () => {
    const settings = parse_minio_connection_settings({
      endpoint_url: 'http://minio',
      access_key: 'cle',
      secret_key: 'secret',
    });

    expect(settings).toMatchObject({ endPoint: 'minio', useSSL: false, port: 80 });
  });

  it('un port explicite est repris tel quel', () => {
    const settings = parse_minio_connection_settings({
      endpoint_url: 'http://127.0.0.1:9000',
      access_key: 'cle',
      secret_key: 'secret',
    });

    expect(settings).toMatchObject({ endPoint: '127.0.0.1', port: 9000, useSSL: false });
  });
});
