import type { ClientUploadTicketView } from './contracts';

export interface UploadProgress {
  readonly transferred_bytes: number;
  readonly total_bytes: number;
}

export class ObjectStorageUploadError extends Error {
  readonly http_status: number | null;

  constructor(http_status: number | null) {
    super('object_storage_upload_failed');
    this.name = 'ObjectStorageUploadError';
    this.http_status = http_status;
  }
}

export interface ObjectStorageUploadInput {
  readonly ticket: ClientUploadTicketView;
  readonly file: File;
  readonly on_progress: (progress: UploadProgress) => void;
}

// `XMLHttpRequest` et non `fetch` : seul le premier rapporte la progression de
// l'ENVOI. `fetch` ne sait rendre que celle du telechargement, et la barre de
// progression est un critere d'evaluation explicite.
//
// Les octets vont du navigateur a MinIO sans passer par l'API : c'est ce qui
// rend cette progression honnete, et ce qui evite de faire transiter vingt
// megaoctets par un processus qui n'a rien a en faire.
export function upload_to_object_storage({
  ticket,
  file,
  on_progress,
}: ObjectStorageUploadInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.upload.addEventListener('progress', (event: ProgressEvent): void => {
      on_progress({
        transferred_bytes: event.loaded,
        total_bytes: event.lengthComputable ? event.total : file.size,
      });
    });

    request.addEventListener('load', (): void => {
      if (request.status >= 200 && request.status < 300) {
        on_progress({ transferred_bytes: file.size, total_bytes: file.size });
        resolve();

        return;
      }

      reject(new ObjectStorageUploadError(request.status));
    });

    request.addEventListener('error', (): void => {
      reject(new ObjectStorageUploadError(null));
    });

    request.open('POST', ticket.upload_url);
    request.send(build_presigned_form(ticket, file));
  });
}

function build_presigned_form(ticket: ClientUploadTicketView, file: File): FormData {
  const form = new FormData();

  // Les champs signes AVANT le fichier, et ce n'est pas cosmetique : la
  // politique pre-signee de S3 exige que le fichier soit le DERNIER champ, sans
  // quoi le stockage refuse l'envoi apres avoir deja lu les octets.
  for (const [name, value] of Object.entries(ticket.form_fields)) {
    form.append(name, value);
  }

  form.append('file', file);

  return form;
}
