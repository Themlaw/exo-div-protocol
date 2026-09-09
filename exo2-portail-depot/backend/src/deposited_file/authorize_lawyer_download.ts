import type { DepositedFile, DepositedFileStatus } from '../domain/deposited_file';
import { is_deposited_file_downloadable } from '../domain/deposited_file';
import { build_activity_event } from '../domain/activity_event';
import {
  VERIFIED_BUCKET_NAME,
  type ObjectStorage,
  type PresignedDownloadTicket,
} from '../object_storage/object_storage';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import type { Clock } from '../shared/clock';
import type { OwnedDepositedFile } from './deposited_file_repository';

export const LAWYER_DOWNLOAD_AUTHORIZER: unique symbol = Symbol('LAWYER_DOWNLOAD_AUTHORIZER');

// Soixante secondes : le temps qu'un navigateur suive la redirection et commence
// son transfert, pas davantage. L'URL signee EST un droit de lecture au porteur
// pendant sa duree de vie — la partager par erreur ne doit rien ouvrir de
// durable. Le transfert deja commence, lui, va a son terme.
export const PRESIGNED_DOWNLOAD_LIFETIME_SECONDS = 60;

export type LawyerDownloadOutcome =
  | { kind: 'authorized'; ticket: PresignedDownloadTicket }
  | { kind: 'unknown_file' }
  | { kind: 'file_not_downloadable'; status: DepositedFileStatus };

export interface LawyerDownloadRequest {
  deposit_request_id: string;
  deposited_file_id: string;
  owner_user_id: string;
}

export interface LawyerDownloadAuthorizer {
  authorize(request: LawyerDownloadRequest): Promise<LawyerDownloadOutcome>;
}

// Ne demande du depot que le predicat d'appartenance : le service n'a aucune
// raison de pouvoir effacer une piece ou en reserver une.
export interface LawyerDownloadDepositedFileReader {
  find_for_owner(
    deposited_file_id: string,
    owner_user_id: string,
  ): Promise<OwnedDepositedFile | null>;
}

export interface LawyerDownloadDependencies {
  deposited_files: LawyerDownloadDepositedFileReader;
  object_storage: ObjectStorage;
  activity_events: ActivityEventRepository;
  clock: Clock;
}

export class LawyerDownloadAuthorizationService implements LawyerDownloadAuthorizer {
  constructor(private readonly dependencies: LawyerDownloadDependencies) {}

  async authorize(request: LawyerDownloadRequest): Promise<LawyerDownloadOutcome> {
    // L'appartenance est un predicat de requete : une piece qui n'est pas d'un
    // dossier de cet avocat n'est pas rendue, donc pas telechargeable.
    const owned: OwnedDepositedFile | null = await this.dependencies.deposited_files.find_for_owner(
      request.deposited_file_id,
      request.owner_user_id,
    );

    // Le chemin porte la demande ET la piece, et les deux doivent concorder.
    // Sans ce rapprochement, une piece du dossier A se telechargerait par l'URL
    // du dossier B, et le journal l'ecrirait sous la mauvaise demande.
    if (owned === null || owned.deposit_request_id !== request.deposit_request_id) {
      return { kind: 'unknown_file' };
    }

    const file: DepositedFile = owned.file;
    if (!is_deposited_file_downloadable(file)) {
      return { kind: 'file_not_downloadable', status: file.status };
    }

    const issued_at: Date = this.dependencies.clock.now();
    // Le bucket VERIFIE : une piece saine y a ete promue, et signer sur la
    // quarantaine viserait un objet qui n'y est plus.
    const ticket: PresignedDownloadTicket =
      await this.dependencies.object_storage.create_presigned_download({
        bucket: VERIFIED_BUCKET_NAME,
        object_key: file.object_key,
        display_filename: file.display_filename,
        lifetime_seconds: PRESIGNED_DOWNLOAD_LIFETIME_SECONDS,
        issued_at,
      });

    // APRES la signature : journaliser avant inscrirait des telechargements qui
    // n'ont jamais eu lieu si la signature echouait. Et ce qu'on journalise est
    // l'EMISSION DU TICKET, pas le transfert des octets — celui-ci se passe
    // entre le navigateur et le stockage, hors de notre vue.
    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id: owned.deposit_request_id,
        type: 'deposited_file_downloaded',
        actor: { kind: 'lawyer', user_id: request.owner_user_id },
        access_link_id: file.access_link_id,
        deposited_file_id: file.id,
        occurred_at: issued_at,
      }),
    );

    return { kind: 'authorized', ticket };
  }
}
