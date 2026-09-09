import type { Readable } from 'node:stream';
import {
  Client as MinioClient,
  CopyConditions,
  NotificationConfig,
  QueueConfig,
  type PostPolicyResult,
} from 'minio';
import type { PresignedUploadPolicy } from '../domain/presigned_upload';
import {
  OBJECT_ARRIVAL_NOTIFICATION_ARN,
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
  type StoredObjectDescription,
} from './object_storage';

export interface MinioConnectionSettings {
  endpoint_url: string;
  access_key: string;
  secret_key: string;
}

// La configuration arrive sous forme d'URL — une seule variable a renseigner,
// et le schema y porte deja le TLS. La decouper en hote, port et booleen dans
// l'environnement multiplierait les facons de se tromper.
export function parse_minio_connection_settings(settings: MinioConnectionSettings): {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
} {
  const endpoint = new URL(settings.endpoint_url);
  const uses_tls: boolean = endpoint.protocol === 'https:';

  return {
    endPoint: endpoint.hostname,
    port: endpoint.port === '' ? (uses_tls ? 443 : 80) : Number(endpoint.port),
    useSSL: uses_tls,
    accessKey: settings.access_key,
    secretKey: settings.secret_key,
  };
}

export class MinioObjectStorage implements ObjectStorage {
  readonly #client: MinioClient;

  constructor(settings: MinioConnectionSettings) {
    this.#client = new MinioClient(parse_minio_connection_settings(settings));
  }

  // Au demarrage de l'application, pas dans install.sh : apres l'installation
  // personne n'a de terminal a ouvrir, et un bucket cree par une commande qu'on
  // oublie de lancer est une installation qui ne sert a rien. Meme raisonnement
  // que l'amorcage du compte de demonstration.
  //
  // Aucune politique publique n'est posee : un bucket MinIO est prive par
  // defaut, et la quarantaine ne doit JAMAIS etre lisible autrement que par
  // nous.
  async ensure_buckets_exist(): Promise<void> {
    for (const bucket_name of [QUARANTINE_BUCKET_NAME, VERIFIED_BUCKET_NAME]) {
      if (!(await this.#client.bucketExists(bucket_name))) {
        await this.#client.makeBucket(bucket_name);
      }
    }
  }

  // Seule la quarantaine est abonnee : le bucket definitif ne recoit d'objets
  // que de nous, par promotion, et s'y abonner relancerait un scan sur un
  // fichier deja juge.
  async ensure_arrival_notifications(): Promise<boolean> {
    const configuration = new NotificationConfig();
    const queue = new QueueConfig(OBJECT_ARRIVAL_NOTIFICATION_ARN);
    queue.addEvent('s3:ObjectCreated:*');
    configuration.add(queue);

    try {
      await this.#client.setBucketNotification(QUARANTINE_BUCKET_NAME, configuration);
      return true;
    } catch {
      return false;
    }
  }

  async create_presigned_upload(
    policy: PresignedUploadPolicy,
    declared_mime_type: string,
  ): Promise<PresignedUploadTicket> {
    const post_policy = this.#client.newPostPolicy();
    post_policy.setBucket(policy.bucket);
    // La cle EXACTE, et non le prefixe : c'est la contrainte la plus forte que
    // la policy sache poser. Le prefixe que porte le domaine reste la borne
    // qu'on se serait donnee s'il avait fallu laisser au client le choix du
    // suffixe — ce qu'on ne fait pas.
    post_policy.setKey(policy.object_key);
    // La seule barriere de taille qui existe : une fois la policy signee, MinIO
    // ne verifie plus rien d'autre, et le plafond du document attendu ne serait
    // applique nulle part.
    post_policy.setContentLengthRange(
      policy.content_length_range.min,
      policy.content_length_range.max,
    );
    // Fige le type annonce : l'objet stocke portera exactement celui qu'on a
    // enregistre en base. Cela ne prouve rien du CONTENU — la detection par
    // magic bytes tranchera — mais cela empeche que la ligne et l'objet
    // racontent deux histoires differentes.
    post_policy.setContentType(declared_mime_type);
    post_policy.setExpires(policy.expires_at);

    const signed: PostPolicyResult = await this.#client.presignedPostPolicy(post_policy);

    return {
      upload_url: signed.postURL,
      form_fields: signed.formData,
      expires_at: policy.expires_at,
    };
  }

  async delete_object(bucket: string, object_key: string): Promise<void> {
    await this.#client.removeObject(bucket, object_key);
  }

  async describe_object(
    bucket: string,
    object_key: string,
  ): Promise<StoredObjectDescription | null> {
    try {
      const stat = await this.#client.statObject(bucket, object_key);
      return { size_bytes: stat.size };
    } catch (error: unknown) {
      // Un objet absent est une reponse, pas une panne. Toute AUTRE erreur
      // remonte : confondre « pas la » avec « MinIO ne repond plus » ferait
      // conclure a une piece disparue sur une simple coupure reseau.
      if (is_object_not_found(error)) {
        return null;
      }
      throw error;
    }
  }

  async read_object_prefix(
    bucket: string,
    object_key: string,
    byte_count: number,
  ): Promise<Buffer> {
    const partial_stream = await this.#client.getPartialObject(bucket, object_key, 0, byte_count);

    const chunks: Buffer[] = [];
    for await (const chunk of partial_stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async open_object_stream(bucket: string, object_key: string): Promise<Readable> {
    return this.#client.getObject(bucket, object_key);
  }

  async *list_object_keys(bucket: string): AsyncIterable<string> {
    // Recursif : les cles de depot portent des `/`, que MinIO traiterait sinon
    // comme des dossiers et n'enumererait pas.
    for await (const entry of this.#client.listObjectsV2(bucket, '', true)) {
      if (entry.name !== undefined) {
        yield entry.name;
      }
    }
  }

  async promote_object(input: {
    from_bucket: string;
    to_bucket: string;
    object_key: string;
  }): Promise<void> {
    await this.#client.copyObject(
      input.to_bucket,
      input.object_key,
      `/${input.from_bucket}/${input.object_key}`,
      new CopyConditions(),
    );

    await this.#client.removeObject(input.from_bucket, input.object_key);
  }
}

function is_object_not_found(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return code === 'NotFound' || code === 'NoSuchKey';
}
