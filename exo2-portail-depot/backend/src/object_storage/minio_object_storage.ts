import type { Readable } from 'node:stream';
import {
  Client as MinioClient,
  CopyConditions,
  NotificationConfig,
  QueueConfig,
  type PostPolicyResult,
} from 'minio';
import type { PresignedUploadPolicy } from '../domain/presigned_upload';
import { build_presigned_download_response_overrides } from '../shared/download_response_headers';
import {
  OBJECT_ARRIVAL_NOTIFICATION_ARN,
  QUARANTINE_BUCKET_NAME,
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedDownloadRequest,
  type PresignedDownloadTicket,
  type PresignedUploadTicket,
  type StoredObjectDescription,
} from './object_storage';

export interface MinioConnectionSettings {
  endpoint_url: string;
  // L'adresse par laquelle un NAVIGATEUR joint le stockage, quand ce n'est pas
  // celle par laquelle l'application le joint. En production l'application parle
  // a MinIO par le reseau interne et le navigateur par le proxy : ce sont deux
  // noms differents, et une URL pre-signee en GET signe l'HOTE — signee sur le
  // nom interne, elle rendrait 403 des que le navigateur la presente.
  //
  // Absente en developpement, ou les deux se confondent.
  public_endpoint_url?: string | undefined;
  access_key: string;
  secret_key: string;
}

// La configuration arrive sous forme d'URL — une seule variable a renseigner,
// et le schema y porte deja le TLS. La decouper en hote, port et booleen dans
// l'environnement multiplierait les facons de se tromper.
// Declaree, et jamais decouverte. Sans region dans ses options, le client MinIO
// la DEMANDE au serveur avant de signer quoi que ce soit — or le client signeur
// est configure sur l'adresse PUBLIQUE du stockage, celle du navigateur, que
// l'application ne peut pas joindre depuis son reseau interne. La demande
// d'autorisation d'envoi rendait alors 500 sur une pile parfaitement saine.
// `us-east-1` est la region par defaut de MinIO en mode simple ; elle entre
// dans la signature SigV4, elle doit donc etre la meme des deux cotes.
export const STORAGE_REGION = 'us-east-1';

export function parse_minio_connection_settings(settings: MinioConnectionSettings): {
  endPoint: string;
  port: number;
  useSSL: boolean;
  region: string;
  accessKey: string;
  secretKey: string;
} {
  const endpoint = new URL(settings.endpoint_url);
  const uses_tls: boolean = endpoint.protocol === 'https:';

  return {
    endPoint: endpoint.hostname,
    port: endpoint.port === '' ? (uses_tls ? 443 : 80) : Number(endpoint.port),
    useSSL: uses_tls,
    region: STORAGE_REGION,
    accessKey: settings.access_key,
    secretKey: settings.secret_key,
  };
}

// Ce qui signe, par opposition a ce qui administre. Les deux se confondent
// partout sauf en production.
export function resolve_minio_signing_settings(settings: MinioConnectionSettings): ReturnType<
  typeof parse_minio_connection_settings
> {
  return parse_minio_connection_settings(
    settings.public_endpoint_url === undefined
      ? settings
      : { ...settings, endpoint_url: settings.public_endpoint_url },
  );
}

// Les deux codes que S3 rend quand le bucket vient d'etre cree : le premier par
// nous, le second par quelqu'un d'autre — impossible sur un MinIO qui n'a qu'un
// seul compte, mais c'est le code que la specification prevoit.
const BUCKET_ALREADY_CREATED_ERROR_CODES: readonly string[] = [
  'BucketAlreadyOwnedByYou',
  'BucketAlreadyExists',
];

export function is_bucket_already_created_error(error: unknown): boolean {
  // Le code, jamais le message : celui de MinIO est une phrase en anglais qu'une
  // mise a jour peut reformuler sans prevenir.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    BUCKET_ALREADY_CREATED_ERROR_CODES.includes(error.code)
  );
}

export class MinioObjectStorage implements ObjectStorage {
  // Deux clients, et non un : celui qui cree les buckets et pose les
  // notifications doit joindre MinIO par le reseau interne — le nom public n'y
  // est pas resolvable, et le proxy n'a pas a porter du trafic d'administration.
  readonly #client: MinioClient;
  readonly #signing_client: MinioClient;

  constructor(settings: MinioConnectionSettings) {
    this.#client = new MinioClient(parse_minio_connection_settings(settings));
    this.#signing_client =
      settings.public_endpoint_url === undefined
        ? this.#client
        : new MinioClient(resolve_minio_signing_settings(settings));
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
      if (await this.#client.bucketExists(bucket_name)) {
        continue;
      }

      try {
        await this.#client.makeBucket(bucket_name);
      } catch (error: unknown) {
        // Le raccourci ci-dessus vaut pour le cas courant — une pile deja
        // installee — et rien de plus : `app` et `worker` partagent cet
        // amorcage et demarrent ENSEMBLE, donc entre le constat et la creation,
        // l'autre a pu creer le bucket. La garantie vient d'ici, pas du test.
        if (!is_bucket_already_created_error(error)) {
          throw error;
        }
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
    const post_policy = this.#signing_client.newPostPolicy();
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

    const signed: PostPolicyResult = await this.#signing_client.presignedPostPolicy(post_policy);

    return {
      upload_url: signed.postURL,
      form_fields: signed.formData,
      expires_at: policy.expires_at,
    };
  }

  async create_presigned_download(
    request: PresignedDownloadRequest,
  ): Promise<PresignedDownloadTicket> {
    // Les en-tetes entrent dans la signature : verifie sur le MinIO du projet,
    // les modifier apres coup rend 403. C'est ce qui empeche le porteur de
    // l'URL de retourner `attachment` en `inline`, donc de faire ouvrir une
    // piece deposee DANS une origine de navigateur.
    const download_url: string = await this.#signing_client.presignedGetObject(
      request.bucket,
      request.object_key,
      request.lifetime_seconds,
      build_presigned_download_response_overrides(request.display_filename),
    );

    return {
      download_url,
      // Derivee de l'instant fourni par l'appelant, et non de l'horloge du
      // process : l'echeance annoncee au front doit venir de la meme horloge
      // que le reste de l'application.
      expires_at: new Date(request.issued_at.getTime() + request.lifetime_seconds * 1000),
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
