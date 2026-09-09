import type { Clock } from '../shared/clock';
import type { DepositedFile } from '../domain/deposited_file';
import {
  is_deposited_file_upload_reservation_abandoned,
  should_quarantine_object_be_collected,
} from '../domain/deposited_file';
import {
  QUARANTINE_BUCKET_NAME,
  type ObjectStorage,
  type StoredObjectDescription,
} from '../object_storage/object_storage';
import type { DepositedFileRepository } from '../deposited_file/deposited_file_repository';
import type { ApplicationLogger } from '../shared/logging/application_logger';
import type { ObjectArrivalRecorder } from './record_object_arrival';
import type { ScanQueue } from './scan_queue';
import type { ActivityEventRepository } from '../activity/activity_event_repository';
import { CLIENT_IP_RETENTION_DAYS } from '../domain/activity_event';

export const DEPOSIT_RECONCILER: unique symbol = Symbol('DEPOSIT_RECONCILER');
export const RECONCILIATION_LOG_CONTEXT = 'reconciliation';

// Doit rester SUPERIEUR a la duree de vie d'un presigned : en deca, le balayage
// effacerait la reservation d'un client dont le transfert est encore en cours.
// Au-dela de cette fenetre, plus aucun objet ne peut arriver — la signature a
// expire — donc une reservation sans objet est definitivement perdue.
export const UPLOAD_RESERVATION_GRACE_MINUTES = 30;

// Un scan qui n'a pas rendu de verdict apres ce delai n'en rendra pas tout
// seul : la notification s'est perdue, le worker est tombe en cours de route,
// ou clamd etait injoignable et les tentatives se sont epuisees.
export const SCAN_OVERDUE_AFTER_MINUTES = 15;

export interface ReconciliationReport {
  missed_arrivals_recorded: number;
  abandoned_reservations_discarded: number;
  overdue_scans_requeued: number;
  orphan_objects_collected: number;
  client_ips_redacted: number;
}

export interface DepositReconciler {
  reconcile(): Promise<ReconciliationReport>;
}

export interface DepositReconciliationDependencies {
  deposited_files: DepositedFileRepository;
  object_storage: ObjectStorage;
  object_arrivals: ObjectArrivalRecorder;
  activity_events: ActivityEventRepository;
  scan_queue: ScanQueue;
  clock: Clock;
  logger: ApplicationLogger;
}

// Le FILET. Tout le chemin nominal repose sur des evenements — une notification
// de MinIO, un job en file — et un evenement se perd : le service tombe entre
// l'ecriture et l'enfilement, MinIO n'a pas de cible configuree, clamd repond
// aux abonnes absents jusqu'a epuisement des tentatives. Sans balayage, chacune
// de ces pannes laisse une piece bloquee pour toujours, et personne ne s'en
// apercoit avant que l'avocat ne reclame un document que le client jure avoir
// depose.
//
// Il est ecrit pour etre REJOUABLE : chaque passe repart de l'etat observe, et
// deux passes de suite ne font pas deux fois le meme travail.
export class DepositReconciliationService implements DepositReconciler {
  constructor(private readonly dependencies: DepositReconciliationDependencies) {}

  async reconcile(): Promise<ReconciliationReport> {
    // L'ORDRE compte. Les arrivees manquees d'abord : elles font passer des
    // pieces de `pending_upload` a `pending_scan`, et leurs objets ne doivent
    // pas etre ramasses comme orphelins par la passe suivante.
    const arrivals = await this.recover_missed_arrivals();
    const overdue_scans_requeued: number = await this.requeue_overdue_scans();
    const orphan_objects_collected: number = await this.collect_stale_quarantine_objects();
    const client_ips_redacted: number = await this.redact_expired_client_ips();

    const report: ReconciliationReport = {
      ...arrivals,
      overdue_scans_requeued,
      orphan_objects_collected,
      client_ips_redacted,
    };

    // Toujours journalise, meme quand tout est a zero : c'est la seule preuve
    // que le balayage tourne encore. Un compteur muet ne se distingue pas d'un
    // processus mort.
    this.dependencies.logger.info(RECONCILIATION_LOG_CONTEXT, 'passe de reconciliation terminee', {
      ...report,
    });

    return report;
  }

  // La retention des adresses est un travail de fond de plus, et il n'a rien a
  // voir avec le scan : il vit ici parce qu'un second ordonnanceur pour trois
  // lignes serait une piece mobile de plus a surveiller. L'evenement RESTE, seule
  // l'adresse part — un journal d'audit qui s'auto-detruit ne prouve rien.
  private async redact_expired_client_ips(): Promise<number> {
    const redact_before: Date = new Date(
      this.dependencies.clock.now().getTime() -
        CLIENT_IP_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    return this.dependencies.activity_events.redact_client_ip_recorded_before(redact_before);
  }

  // Une piece reste en `pending_upload` alors que son objet est bien arrive
  // quand la notification ne nous est jamais parvenue. On la rejoue comme si
  // MinIO venait de l'annoncer, plutot que de reimplementer ici la meme
  // decision — deux chemins d'enregistrement auraient fini par diverger.
  private async recover_missed_arrivals(): Promise<{
    missed_arrivals_recorded: number;
    abandoned_reservations_discarded: number;
  }> {
    const now: Date = this.dependencies.clock.now();
    const reservations: readonly DepositedFile[] =
      await this.dependencies.deposited_files.list_upload_reservations_created_before(now);

    let missed_arrivals_recorded = 0;
    let abandoned_reservations_discarded = 0;

    for (const reservation of reservations) {
      const stored_object: StoredObjectDescription | null =
        await this.dependencies.object_storage.describe_object(
          QUARANTINE_BUCKET_NAME,
          reservation.object_key,
        );

      if (stored_object !== null) {
        await this.dependencies.object_arrivals.record({
          bucket: QUARANTINE_BUCKET_NAME,
          object_key: reservation.object_key,
          size_bytes: stored_object.size_bytes,
        });
        missed_arrivals_recorded += 1;
        continue;
      }

      // Pas d'objet, et la signature a expire : rien ne viendra plus. On ne
      // touche pas aux reservations plus recentes, dont le transfert peut etre
      // en cours a cet instant meme.
      if (
        is_deposited_file_upload_reservation_abandoned(
          reservation,
          UPLOAD_RESERVATION_GRACE_MINUTES,
          now,
        )
      ) {
        await this.dependencies.deposited_files.delete_file(reservation.id);
        abandoned_reservations_discarded += 1;
      }
    }

    return { missed_arrivals_recorded, abandoned_reservations_discarded };
  }

  // Reenfile plutot que de scanner ici : la file porte deja les tentatives, le
  // recul entre elles et l'unicite par piece. Scanner sur place ferait du
  // balayage un second executeur, capable de traiter la meme piece que le
  // worker au meme moment.
  private async requeue_overdue_scans(): Promise<number> {
    const overdue_before: Date = new Date(
      this.dependencies.clock.now().getTime() - SCAN_OVERDUE_AFTER_MINUTES * 60 * 1000,
    );

    const overdue_files: readonly DepositedFile[] =
      await this.dependencies.deposited_files.list_scans_pending_since_before(overdue_before);

    for (const file of overdue_files) {
      await this.dependencies.scan_queue.enqueue_scan({ deposited_file_id: file.id });
    }

    if (overdue_files.length > 0) {
      this.dependencies.logger.warn(RECONCILIATION_LOG_CONTEXT, 'scans en retard reenfiles', {
        deposited_file_count: overdue_files.length,
        overdue_after_minutes: SCAN_OVERDUE_AFTER_MINUTES,
      });
    }

    return overdue_files.length;
  }

  // Le bucket est ici la SOURCE : on part de ce qui est reellement stocke, pas
  // de ce que la base croit. Un objet dont la ligne a disparu n'apparaitrait
  // dans aucune requete, et resterait donc facture et stocke pour toujours.
  private async collect_stale_quarantine_objects(): Promise<number> {
    let collected = 0;

    for await (const object_key of this.dependencies.object_storage.list_object_keys(
      QUARANTINE_BUCKET_NAME,
    )) {
      const file: DepositedFile | null =
        await this.dependencies.deposited_files.find_by_object_key(object_key);

      // `null` : plus aucune piece ne le reclame. Sinon, seuls les statuts
      // terminaux sont ramasses — une piece promue, effacee ou refusee n'a plus
      // rien a faire en quarantaine, la ou `pending_scan` attend precisement
      // qu'on lise son objet.
      if (file !== null && !should_quarantine_object_be_collected(file)) {
        continue;
      }

      await this.dependencies.object_storage.delete_object(QUARANTINE_BUCKET_NAME, object_key);
      collected += 1;

      this.dependencies.logger.warn(RECONCILIATION_LOG_CONTEXT, 'objet ramasse en quarantaine', {
        object_key,
        deposited_file_status: file?.status ?? 'aucune_piece',
      });
    }

    return collected;
  }
}
