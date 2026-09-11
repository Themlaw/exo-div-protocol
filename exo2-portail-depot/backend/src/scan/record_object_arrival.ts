import type { Clock } from '../shared/clock';
import type { DepositedFile } from '../domain/deposited_file';
import { reset_deposited_file_after_new_object_arrival } from '../domain/deposited_file';
import { QUARANTINE_BUCKET_NAME, type ObjectStorage } from '../object_storage/object_storage';
import {
  ExpectedDocumentAlreadyOccupiedError,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import type { ObjectArrivalNotification } from './storage_event';
import type { ScanQueue } from './scan_queue';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import { build_activity_event } from '../domain/activity_event';
import type { ExpectedDocumentRepository } from '../deposit/expected_document_repository';
import type { ExpectedDocument } from '../domain/expected_document';

export const OBJECT_ARRIVAL_RECORDER: unique symbol = Symbol('OBJECT_ARRIVAL_RECORDER');
export const OBJECT_ARRIVAL_LOG_CONTEXT = 'object_arrival';

export type ObjectArrivalOutcome =
  | { kind: 'queued_for_scan' }
  | { kind: 'orphan_object_deleted' }
  | { kind: 'ignored_outside_quarantine' };

export interface ObjectArrivalRecorder {
  record(notification: ObjectArrivalNotification): Promise<ObjectArrivalOutcome>;
}

export interface ObjectArrivalDependencies {
  deposited_files: DepositedFileRepository;
  expected_documents: ExpectedDocumentRepository;
  activity_events: ActivityEventRepository;
  object_storage: ObjectStorage;
  scan_queue: ScanQueue;
  clock: Clock;
  logger: ApplicationLogger;
}

// La SEULE source de verite sur l'arrivee d'un objet. Le navigateur qui annonce
// « j'ai fini » n'en est pas une : il peut mentir, se fermer en cours de route,
// ou avoir ete interrompu apres que les octets sont partis.
export class ObjectArrivalRecordingService implements ObjectArrivalRecorder {
  constructor(private readonly dependencies: ObjectArrivalDependencies) {}

  async record(notification: ObjectArrivalNotification): Promise<ObjectArrivalOutcome> {
    // Le bucket definitif ne recoit d'objets que de NOUS, par promotion : une
    // notification venue de lui ne decrit pas un depot client et relancerait un
    // scan sur un fichier deja juge.
    if (notification.bucket !== QUARANTINE_BUCKET_NAME) {
      return { kind: 'ignored_outside_quarantine' };
    }

    const file: DepositedFile | null = await this.dependencies.deposited_files.find_by_object_key(
      notification.object_key,
    );

    // Un objet qui n'appartient a aucune piece : upload termine apres une
    // revocation, ou reservation deja retiree. Il ne sera jamais rattache a
    // quoi que ce soit, et le laisser en quarantaine reviendrait a stocker
    // indefiniment un fichier que personne ne reclamera.
    if (file === null) {
      await this.dependencies.object_storage.delete_object(
        QUARANTINE_BUCKET_NAME,
        notification.object_key,
      );
      this.dependencies.logger.warn(
        OBJECT_ARRIVAL_LOG_CONTEXT,
        'objet orphelin supprime de la quarantaine',
        { object_key: notification.object_key },
      );
      return { kind: 'orphan_object_deleted' };
    }

    // Une piece qui n'attendait plus son objet a DEJA recu cette arrivee : MinIO
    // rejoue ses notifications jusqu'a obtenir un 2xx, et un vrai second depot
    // passe forcement par une nouvelle autorisation, donc par une nouvelle cle
    // d'objet et une ligne remise en attente. C'est ce qui distingue le depot du
    // rejeu, et c'est le journal qui en depend : la file, elle, se protege deja
    // par sa cle d'unicite.
    const was_still_awaiting_its_object: boolean = file.status === 'pending_upload';

    const now: Date = this.dependencies.clock.now();
    const file_after_arrival: DepositedFile = {
      // Le meme reset qu'une reecriture : un fichier deja juge qui recoit un
      // nouvel objet ne garde pas son verdict, sinon un fichier sain remplace
      // apres coup heriterait de sa validation.
      ...reset_deposited_file_after_new_object_arrival(file, now),
      actual_size_bytes: notification.size_bytes,
    };

    try {
      await this.dependencies.deposited_files.save_state(file_after_arrival);
    } catch (error: unknown) {
      if (error instanceof ExpectedDocumentAlreadyOccupiedError) {
        return this.discard_superseded_arrival(file);
      }
      throw error;
    }

    // C'est l'ARRIVEE qui fait le depot, pas la reservation : une autorisation
    // d'ecriture que le client n'utilise jamais n'a rien depose, et la
    // journaliser ferait un journal de pieces inexistantes.
    if (was_still_awaiting_its_object) {
      await this.journalize_reception(file_after_arrival);
    }

    // Enfile APRES l'ecriture : un job qui partirait avant trouverait une piece
    // encore en attente d'upload et conclurait a un objet absent.
    await this.dependencies.scan_queue.enqueue_scan({ deposited_file_id: file.id });

    return { kind: 'queued_for_scan' };
  }

  // La piece ne porte pas sa demande : elle designe un document attendu, qui
  // seul sait a quel dossier il appartient.
  private async journalize_reception(file: DepositedFile): Promise<void> {
    const expected_document: ExpectedDocument | null =
      await this.dependencies.expected_documents.find_by_id(file.expected_document_id);

    if (expected_document === null) {
      return;
    }

    await this.dependencies.activity_events.record(
      build_activity_event({
        deposit_request_id: expected_document.deposit_request_id,
        type: 'deposited_file_received',
        actor: { kind: 'client' },
        access_link_id: file.access_link_id,
        deposited_file_id: file.id,
        occurred_at: this.dependencies.clock.now(),
      }),
    );
  }

  // Deux reservations avaient ete delivrees sur le meme emplacement — chacune
  // legitime, aucune n'occupant tant que rien n'etait arrive — et l'autre a
  // gagne la course. Celle-ci ne pourra jamais rien occuper : son objet part,
  // et sa ligne avec, plutot que de laisser une piece en attente eternelle.
  private async discard_superseded_arrival(file: DepositedFile): Promise<ObjectArrivalOutcome> {
    await this.dependencies.deposited_files.delete_file(file.id);
    await this.dependencies.object_storage.delete_object(
      QUARANTINE_BUCKET_NAME,
      file.object_key,
    );

    this.dependencies.logger.warn(
      OBJECT_ARRIVAL_LOG_CONTEXT,
      'arrivee ecartee : l emplacement avait deja ete pris',
      { deposited_file_id: file.id, expected_document_id: file.expected_document_id },
    );

    return { kind: 'orphan_object_deleted' };
  }
}
