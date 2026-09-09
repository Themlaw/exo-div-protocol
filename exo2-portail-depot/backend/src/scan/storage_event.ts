// Ce que MinIO envoie sur le webhook, reduit a ce dont on a besoin. Le format
// est celui des notifications S3 : un tableau d'evenements, chacun nommant son
// bucket, sa cle et la taille de l'objet.
export interface ObjectArrivalNotification {
  bucket: string;
  object_key: string;
  size_bytes: number;
}

// Tolerante par construction : une notification qu'on ne comprend pas est
// ignoree, jamais rejetee en erreur. MinIO reessaierait indefiniment un
// evenement que nous ne saurons de toute facon jamais lire, et la
// reconciliation periodique rattrape ce que le webhook a manque.
export function read_object_arrival_notifications(
  body: unknown,
): readonly ObjectArrivalNotification[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }

  const { Records: records } = body as { Records?: unknown };
  if (!Array.isArray(records)) {
    return [];
  }

  return records.flatMap((record: unknown): ObjectArrivalNotification[] => {
    const arrival = read_single_notification(record);
    return arrival === null ? [] : [arrival];
  });
}

function read_single_notification(record: unknown): ObjectArrivalNotification | null {
  if (typeof record !== 'object' || record === null) {
    return null;
  }

  const { s3 } = record as { s3?: unknown };
  if (typeof s3 !== 'object' || s3 === null) {
    return null;
  }

  const { bucket, object } = s3 as { bucket?: unknown; object?: unknown };
  const bucket_name: unknown = (bucket as { name?: unknown } | undefined)?.name;
  const { key, size } = (object ?? {}) as { key?: unknown; size?: unknown };

  if (typeof bucket_name !== 'string' || typeof key !== 'string' || typeof size !== 'number') {
    return null;
  }

  return {
    bucket: bucket_name,
    // S3 encode la cle pour l'URL : nos cles sont des UUID separes par des
    // barres obliques, mais decoder est ce que la specification demande, et
    // s'en dispenser casserait le jour ou une cle changerait de forme.
    object_key: safely_decode_object_key(key),
    size_bytes: size,
  };
}

function safely_decode_object_key(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    // Une cle mal encodee n'est pas une des notres : la laisser telle quelle la
    // rend introuvable, ce qui est exactement le bon resultat.
    return key;
  }
}
