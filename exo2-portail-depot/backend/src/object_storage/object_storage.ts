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
export interface ObjectStorage {
  ensure_buckets_exist(): Promise<void>;

  create_presigned_upload(
    policy: PresignedUploadPolicy,
    declared_mime_type: string,
  ): Promise<PresignedUploadTicket>;

  // Idempotente : supprimer un objet qui n'est pas la n'est pas une erreur.
  // Une piece dont l'upload n'est jamais arrive se retire comme une autre, et
  // un objet infecte doit pouvoir etre efface deux fois sans casser le worker.
  delete_object(bucket: string, object_key: string): Promise<void>;
}
