import {
  parse_minio_connection_settings,
  resolve_minio_signing_settings,
  is_bucket_already_created_error,
  STORAGE_REGION,
} from '../../../src/object_storage/minio_object_storage';

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

describe('Endpoint public de MinIO', () => {
  const CREDENTIALS = { access_key: 'portail-minio', secret_key: 'un-secret' } as const;

  it('signe pour l endpoint public quand il differe de l interne', () => {
    // Une URL pre-signee en GET signe l'HOTE : signee sur `minio:9000`, elle
    // rend 403 des que le navigateur la presente a `portail.example`. En
    // production les deux ne sont pas le meme nom — l'application parle a MinIO
    // par le reseau interne, le navigateur par le proxy.
    const signing = resolve_minio_signing_settings({
      endpoint_url: 'http://minio:9000',
      public_endpoint_url: 'https://portail.example',
      ...CREDENTIALS,
    });

    expect(signing).toEqual({
      endPoint: 'portail.example',
      port: 443,
      useSSL: true,
      region: STORAGE_REGION,
      accessKey: CREDENTIALS.access_key,
      secretKey: CREDENTIALS.secret_key,
    });
  });

  it('retombe sur l endpoint interne quand aucun public n est declare', () => {
    // Le cas du developpement : l'application et le navigateur joignent MinIO
    // par la meme adresse, et exiger une seconde variable pour rien serait une
    // facon de plus de se tromper.
    expect(
      resolve_minio_signing_settings({
        endpoint_url: 'http://127.0.0.1:22320',
        ...CREDENTIALS,
      }),
    ).toEqual(
      parse_minio_connection_settings({ endpoint_url: 'http://127.0.0.1:22320', ...CREDENTIALS }),
    );
  });
});

describe('Region de signature', () => {
  // La panne que ces deux tests empechent : sans region declaree, le client
  // MinIO va la DEMANDER au serveur avant de signer. Le client signeur, lui,
  // est configure sur l'adresse PUBLIQUE — depuis le conteneur, cette adresse
  // ne mene nulle part. La demande d'autorisation d'envoi rendait donc 500 en
  // production, sur une pile pourtant entierement saine, et aucun test ne
  // pouvait le voir : en developpement les deux adresses sont la meme.
  it('declare une region explicite pour l administration', () => {
    expect(
      parse_minio_connection_settings({
        endpoint_url: 'http://minio:9000',
        access_key: 'cle',
        secret_key: 'secret',
      }),
    ).toMatchObject({ region: STORAGE_REGION });
  });

  it('declare la MEME region pour la signature', () => {
    // La meme, et pas une autre : la region entre dans la signature SigV4. Deux
    // valeurs differentes feraient refuser par le serveur ce que l'application
    // vient de signer.
    expect(
      resolve_minio_signing_settings({
        endpoint_url: 'http://minio:9000',
        public_endpoint_url: 'https://portail.example',
        access_key: 'cle',
        secret_key: 'secret',
      }).region,
    ).toBe(
      parse_minio_connection_settings({
        endpoint_url: 'http://minio:9000',
        access_key: 'cle',
        secret_key: 'secret',
      }).region,
    );
  });
});

describe('is_bucket_already_created_error', () => {
  // La panne reelle : `app` et `worker` partagent l'image, donc le meme
  // amorcage, et demarrent en meme temps. Les deux constatent que le bucket
  // n'existe pas, les deux le creent, et le perdant reçoit cette erreur. Le
  // conteneur redemarrait alors en boucle sur une installation parfaitement
  // saine — exactement le cas que l'amorcage du compte avocat absorbe deja en
  // rattrapant la violation d'unicite.
  it('reconnait la course entre deux amorcages simultanes', () => {
    expect(is_bucket_already_created_error({ code: 'BucketAlreadyOwnedByYou' })).toBe(true);
    expect(is_bucket_already_created_error({ code: 'BucketAlreadyExists' })).toBe(true);
  });

  it('ne reconnait rien d autre', () => {
    // Absorber largement ferait passer un stockage injoignable ou des
    // identifiants faux pour un demarrage reussi, et l'application servirait
    // des depots vers un bucket qui n'existe pas.
    expect(is_bucket_already_created_error({ code: 'AccessDenied' })).toBe(false);
    expect(is_bucket_already_created_error(new Error('ECONNREFUSED'))).toBe(false);
    expect(is_bucket_already_created_error(undefined)).toBe(false);
    expect(is_bucket_already_created_error('BucketAlreadyOwnedByYou')).toBe(false);
  });
});
