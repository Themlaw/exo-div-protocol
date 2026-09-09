import { Readable } from 'node:stream';
import type { PresignedUploadPolicy } from '../../src/domain/presigned_upload';
import type {
  ObjectStorage,
  PresignedUploadTicket,
  StoredObjectDescription,
} from '../../src/object_storage/object_storage';

// Un stockage en memoire, partage par tous les tests du scan. Il tient les
// buckets par leur nom : c'est ce qui permet de verifier qu'une promotion a bien
// DEPLACE l'objet, et non simplement declare la piece saine.
export class FakeObjectStorage implements ObjectStorage {
  readonly buckets = new Map<string, Map<string, Buffer>>();
  readonly deleted_keys: { bucket: string; object_key: string }[] = [];
  arrival_notifications_configured = true;

  put(bucket: string, object_key: string, content: Buffer): void {
    const objects: Map<string, Buffer> = this.buckets.get(bucket) ?? new Map();
    objects.set(object_key, content);
    this.buckets.set(bucket, objects);
  }

  keys_of(bucket: string): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])];
  }

  async ensure_buckets_exist(): Promise<void> {}

  async ensure_arrival_notifications(): Promise<boolean> {
    return this.arrival_notifications_configured;
  }

  async create_presigned_upload(
    policy: PresignedUploadPolicy,
    declared_mime_type: string,
  ): Promise<PresignedUploadTicket> {
    return {
      upload_url: `https://storage.test/${policy.bucket}`,
      form_fields: { key: policy.object_key, 'Content-Type': declared_mime_type },
      expires_at: policy.expires_at,
    };
  }

  async delete_object(bucket: string, object_key: string): Promise<void> {
    this.deleted_keys.push({ bucket, object_key });
    this.buckets.get(bucket)?.delete(object_key);
  }

  async describe_object(
    bucket: string,
    object_key: string,
  ): Promise<StoredObjectDescription | null> {
    const content: Buffer | undefined = this.buckets.get(bucket)?.get(object_key);
    return content === undefined ? null : { size_bytes: content.byteLength };
  }

  async read_object_prefix(
    bucket: string,
    object_key: string,
    byte_count: number,
  ): Promise<Buffer> {
    return (this.buckets.get(bucket)?.get(object_key) ?? Buffer.alloc(0)).subarray(0, byte_count);
  }

  async open_object_stream(bucket: string, object_key: string): Promise<Readable> {
    const content: Buffer | undefined = this.buckets.get(bucket)?.get(object_key);

    if (content === undefined) {
      throw new Error(`objet absent : ${bucket}/${object_key}`);
    }

    return Readable.from([content]);
  }

  async *list_object_keys(bucket: string): AsyncIterable<string> {
    // Une copie du tableau de cles : les balayages suppriment pendant qu'ils
    // parcourent, et iterer la Map elle-meme sauterait des entrees.
    for (const object_key of this.keys_of(bucket)) {
      yield object_key;
    }
  }

  async promote_object(input: {
    from_bucket: string;
    to_bucket: string;
    object_key: string;
  }): Promise<void> {
    const content: Buffer | undefined = this.buckets.get(input.from_bucket)?.get(input.object_key);

    if (content === undefined) {
      throw new Error(`objet absent : ${input.from_bucket}/${input.object_key}`);
    }

    this.put(input.to_bucket, input.object_key, content);
    this.buckets.get(input.from_bucket)?.delete(input.object_key);
  }
}
