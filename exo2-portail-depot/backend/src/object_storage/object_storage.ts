import type { Readable } from 'node:stream';
import type { PresignedUploadPolicy } from '../domain/presigned_upload';

export const OBJECT_STORAGE: unique symbol = Symbol('OBJECT_STORAGE');

// Deux bucketss, et la separation est la mesure de securite elle-meme : ce qui
// vient d'arriver n'est pas encore examine, et ne doit jamais cotoyer ce qui
// l'a ete. Un fichier ne passe de l'un a l'autre que sur un verdict.
export const QUARANTINE_BUCKET_NAME = 'depot-quarantine';
export const VERIFIED_BUCKET_NAME = 'depot-verified';

// Ce que le navigateur doit poster, et rien de plus : l'URL, les champs de
// formulaire signes, et l'echeance pour que le front sache quand redemander.
export interface PresignedUploadTicket {
  upload_url: string;
  form_fields: Readonly<Record<string, string>>;
  expires_at: Date;
}

// Le port. Aucune signature n'y parle de MinIO : c'est ce qui fait que passer a
// un autre S3 est un fichier d'adaptateur, pas une reecriture. Le domaine, lui,
// ne connait meme pas ce port — il produit une `PresignedUploadPolicy`, une
// valeur pure, et c'est l'adaptateur qui la signe.
// La cible de notification declaree cote serveur MinIO. Le nom est une
// convention partagee avec le compose : MinIO expose sa cible sous cet ARN une
// fois `MINIO_NOTIFY_WEBHOOK_*_portail` renseigne.
export const OBJECT_ARRIVAL_NOTIFICATION_ARN = 'arn:minio:sqs::portail:webhook';

// Ce que le navigateur doit ouvrir, et rien de plus. Les octets ne passent
// JAMAIS par nous : ils vont du stockage au poste de l'avocat, et l'echeance
// dit au front dans combien de temps l'URL cesse de valoir quoi que ce soit.
export interface PresignedDownloadTicket {
  download_url: string;
  expires_at: Date;
}

export interface PresignedDownloadRequest {
  bucket: string;
  object_key: string;
  // Le nom que verra l'avocat. La cle de l'objet ne le porte pas — elle est
  // construite par nous a partir d'identifiants — donc sans lui le fichier
  // arriverait nomme comme un UUID.
  display_filename: string;
  lifetime_seconds: number;
  issued_at: Date;
}

export interface ObjectStorage {
  ensure_buckets_exist(): Promise<void>;

  // Abonne la quarantaine aux arrivees d'objets. Rend `false` quand MinIO ne
  // connait pas la cible — cas du developpement, ou le serveur n'est pas
  // configure pour appeler l'API. Un `false` n'est pas une panne : le scan se
  // declenche alors par la reconciliation periodique, plus tard mais surement.
  ensure_arrival_notifications(): Promise<boolean>;

  create_presigned_upload(
    policy: PresignedUploadPolicy,
    declared_mime_type: string,
  ): Promise<PresignedUploadTicket>;

  // La contrepartie en lecture du presigne d'ecriture, et la raison est la
  // meme : une piece de deux cents megaoctets relayee par nous occuperait le
  // process Node pendant tout le transfert. Les en-tetes de protection ne se
  // posent donc pas sur une reponse — il n'y en a pas — mais entrent dans la
  // SIGNATURE, ce qui les rend intouchables par le porteur de l'URL.
  create_presigned_download(request: PresignedDownloadRequest): Promise<PresignedDownloadTicket>;

  // Idempotente : supprimer un objet qui n'est pas la n'est pas une erreur.
  // Une piece dont l'upload n'est jamais arrive se retire comme une autre, et
  // un objet infecte doit pouvoir etre efface deux fois sans casser le worker.
  delete_object(bucket: string, object_key: string): Promise<void>;

  // `null` quand l'objet n'existe pas : c'est une reponse, pas une erreur. Une
  // notification peut arriver pour un objet deja supprime.
  describe_object(bucket: string, object_key: string): Promise<StoredObjectDescription | null>;

  // Les premiers octets seulement : reconnaitre un format ne demande pas de
  // rapatrier vingt megaoctets dans la memoire du worker.
  read_object_prefix(bucket: string, object_key: string, byte_count: number): Promise<Buffer>;

  // En FLUX : l'objet va de MinIO au scanner sans jamais toucher le disque. Les
  // conteneurs sont en lecture seule, et un temporaire exigerait un volume
  // partage entre le worker et le scanner — une surface de plus pour rien.
  open_object_stream(bucket: string, object_key: string): Promise<Readable>;

  // Un flux de CLES, pas d'objets, et paresseux : la reconciliation compare des
  // cles a des lignes, et un bucket de production ne tient pas dans un tableau.
  list_object_keys(bucket: string): AsyncIterable<string>;

  // Copie puis suppression, dans cet ordre : l'inverse perdrait la piece si la
  // copie echouait. Une promotion interrompue laisse l'objet dans les deux
  // buckets, ce que la reconciliation sait nettoyer — la perdre, non.
  promote_object(input: {
    from_bucket: string;
    to_bucket: string;
    object_key: string;
  }): Promise<void>;
}

export interface StoredObjectDescription {
  size_bytes: number;
}
