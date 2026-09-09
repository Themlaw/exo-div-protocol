import { Client as MinioClient, type PostPolicyResult } from 'minio';
import type { PresignedUploadPolicy } from '../domain/presigned_upload';
import {
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
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
}
