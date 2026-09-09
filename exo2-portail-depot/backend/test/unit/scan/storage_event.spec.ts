import {
  read_object_arrival_notifications,
  type ObjectArrivalNotification,
} from '../../../src/scan/storage_event';

function build_notification_body(...records: readonly unknown[]): unknown {
  return { Records: records };
}

function build_valid_record(object_key: string, size_bytes = 1024): unknown {
  return {
    s3: {
      bucket: { name: 'depot-quarantine' },
      object: { key: object_key, size: size_bytes },
    },
  };
}

describe('read_object_arrival_notifications', () => {
  it.each([
    ['une chaine', 'pas un objet'],
    ['un nombre', 42],
    ['null', null],
    ['undefined', undefined],
  ])('un corps qui n\'est pas un objet (%s) ne rend aucune notification plutot que de lever', (
    _description: string,
    body: unknown,
  ) => {
    expect(read_object_arrival_notifications(body)).toEqual([]);
  });

  it.each([
    ['absent', {}],
    ['non tableau', { Records: { s3: {} } }],
    ['une chaine', { Records: 'depot-quarantine' }],
    ['null', { Records: null }],
  ])('un corps dont Records est %s ne rend aucune notification', (
    _description: string,
    body: unknown,
  ) => {
    expect(read_object_arrival_notifications(body)).toEqual([]);
  });

  it('lit le bucket, la cle et la taille d\'une notification bien formee', () => {
    const notifications: readonly ObjectArrivalNotification[] = read_object_arrival_notifications(
      build_notification_body(build_valid_record('request-1/document-1/upload-1', 2048)),
    );

    expect(notifications).toEqual([
      {
        bucket: 'depot-quarantine',
        object_key: 'request-1/document-1/upload-1',
        size_bytes: 2048,
      },
    ]);
  });

  // MinIO reessaierait indefiniment un lot rejete en bloc : un enregistrement
  // illisible ne doit couter que lui-meme, jamais ses voisins du meme lot.
  it('ignore un enregistrement malforme sans faire echouer les autres du meme lot', () => {
    const notifications: readonly ObjectArrivalNotification[] = read_object_arrival_notifications(
      build_notification_body(
        'pas un objet',
        null,
        { s3: null },
        { s3: { bucket: { name: 'depot-quarantine' } } },
        build_valid_record('upload-valide'),
      ),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.object_key).toBe('upload-valide');
  });

  it.each([
    ['la taille est une chaine', { key: 'upload-1', size: '1024' }],
    ['la cle est absente', { size: 1024 }],
    ['la cle est un nombre', { key: 12, size: 1024 }],
    ['la taille est absente', { key: 'upload-1' }],
  ])('ignore un enregistrement dont %s', (_description: string, object: unknown) => {
    const body: unknown = build_notification_body({
      s3: { bucket: { name: 'depot-quarantine' }, object },
    });

    expect(read_object_arrival_notifications(body)).toEqual([]);
  });

  it('ignore un enregistrement dont le nom de bucket n\'est pas une chaine', () => {
    const body: unknown = build_notification_body({
      s3: { bucket: { name: 7 }, object: { key: 'upload-1', size: 1024 } },
    });

    expect(read_object_arrival_notifications(body)).toEqual([]);
  });

  it('decode une cle encodee pour l\'URL', () => {
    const notifications: readonly ObjectArrivalNotification[] = read_object_arrival_notifications(
      build_notification_body(build_valid_record('request-1%2Fdocument-1%2Fupload-1')),
    );

    expect(notifications[0]?.object_key).toBe('request-1/document-1/upload-1');
  });

  it('traite le plus comme une espace, conformement a l\'encodage S3', () => {
    const notifications: readonly ObjectArrivalNotification[] = read_object_arrival_notifications(
      build_notification_body(build_valid_record('request-1/contrat+signe.pdf')),
    );

    expect(notifications[0]?.object_key).toBe('request-1/contrat signe.pdf');
  });

  // Une cle mal encodee n'est aucune des notres : la rendre telle quelle la
  // laisse introuvable, ce qui vaut mieux qu'une notification perdue.
  it('rend une cle mal encodee telle quelle plutot que de lever', () => {
    const notifications: readonly ObjectArrivalNotification[] = read_object_arrival_notifications(
      build_notification_body(build_valid_record('request-1/%zz-upload')),
    );

    expect(notifications[0]?.object_key).toBe('request-1/%zz-upload');
  });
});
