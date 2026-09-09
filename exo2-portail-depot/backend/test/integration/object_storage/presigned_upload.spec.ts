import {
  create_integration_test_application,
  close_integration_test_application,
  type IntegrationTestApplication,
} from '../../helpers/integration_application';
import {
  OBJECT_STORAGE,
  QUARANTINE_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
} from '../../../src/object_storage/object_storage';
import { build_presigned_upload_policy } from '../../../src/domain/presigned_upload';

const DECLARED_MIME_TYPE = 'application/pdf';
const MAXIMUM_UPLOAD_SIZE_BYTES = 1024;

async function post_to_presigned_url(
  ticket: PresignedUploadTicket,
  file_content: Buffer,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const form = new FormData();
  for (const [field_name, field_value] of Object.entries({
    ...ticket.form_fields,
    ...overrides,
  })) {
    form.append(field_name, field_value);
  }
  // Le fichier EN DERNIER : la specification du POST S3 impose que tous les
  // champs de la policy precedent le contenu, sinon le serveur les ignore.
  form.append('file', new Blob([new Uint8Array(file_content)], { type: DECLARED_MIME_TYPE }));

  return fetch(ticket.upload_url, { method: 'POST', body: form });
}

describe('Upload pre-signe vers la quarantaine', () => {
  let integration_test_application: IntegrationTestApplication | undefined;
  let object_storage: ObjectStorage;
  let issued_object_count = 0;

  function build_ticket_for(expires_in_seconds = 600): Promise<PresignedUploadTicket> {
    issued_object_count += 1;
    return object_storage.create_presigned_upload(
      build_presigned_upload_policy({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: `integration/presigned/${Date.now()}-${issued_object_count}`,
        max_size_bytes: MAXIMUM_UPLOAD_SIZE_BYTES,
        expires_at: new Date(Date.now() + expires_in_seconds * 1000),
      }),
      DECLARED_MIME_TYPE,
    );
  }

  beforeAll(async () => {
    integration_test_application = await create_integration_test_application();
    object_storage = integration_test_application.app.get<ObjectStorage>(OBJECT_STORAGE);
  });

  afterAll(async () => {
    await close_integration_test_application(integration_test_application);
  });

  // Les buckets sont crees par l'amorcage au demarrage : delivrer une policy
  // sur un bucket inexistant echouerait a l'envoi, pas a la signature.
  it('le bucket de quarantaine existe des le demarrage de l application', async () => {
    const ticket = await build_ticket_for();
    const response = await post_to_presigned_url(ticket, Buffer.alloc(64, 1));

    expect(response.status).toBe(204);
  });

  // LA propriete du presigned : une fois la policy signee, elle est la seule
  // barriere. Si MinIO acceptait ce fichier, le plafond du document attendu ne
  // serait applique nulle part — le navigateur, lui, n'est pas une barriere.
  it('un fichier au-dessus du plafond est refuse par MinIO, pas par nous', async () => {
    const ticket = await build_ticket_for();

    const response = await post_to_presigned_url(
      ticket,
      Buffer.alloc(MAXIMUM_UPLOAD_SIZE_BYTES + 1, 1),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('un fichier vide est refuse : la borne basse de la policy vaut un octet', async () => {
    const ticket = await build_ticket_for();

    const response = await post_to_presigned_url(ticket, Buffer.alloc(0));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // La cle est signee EXACTEMENT : sans cela, le porteur d'une policy ecrirait
  // ou il veut dans le bucket, y compris par-dessus la piece d'un autre.
  it('le porteur de la policy ne peut pas ecrire sous une autre cle', async () => {
    const ticket = await build_ticket_for();

    const response = await post_to_presigned_url(ticket, Buffer.alloc(64, 1), {
      key: 'integration/presigned/cle-choisie-par-le-client',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('une policy expiree n ouvre plus rien', async () => {
    const ticket = await object_storage.create_presigned_upload(
      build_presigned_upload_policy({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key: `integration/presigned/expiree-${Date.now()}`,
        max_size_bytes: MAXIMUM_UPLOAD_SIZE_BYTES,
        expires_at: new Date(Date.now() - 1000),
      }),
      DECLARED_MIME_TYPE,
    );

    const response = await post_to_presigned_url(ticket, Buffer.alloc(64, 1));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // Supprimer un objet absent ne leve pas : une piece dont l'upload n'est
  // jamais arrive se retire comme une autre, et le worker de scan doit pouvoir
  // rejouer une suppression sans casser.
  it('la suppression est idempotente', async () => {
    await expect(
      object_storage.delete_object(QUARANTINE_BUCKET_NAME, 'integration/objet-jamais-ecrit'),
    ).resolves.toBeUndefined();
  });
});
