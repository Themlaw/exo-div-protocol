import type { Clock } from '../shared/clock';
import type { FileScanner } from '../scan/clamav_scanner';
import type { ScanQueueHealthReader } from '../scan/scan_queue_health';
import type { ScanQueueSnapshot, ScannerAvailability, WorkerHealthSource } from './metrics';

export interface ScanChainHealthDependencies {
  scan_queue: ScanQueueHealthReader;
  file_scanner: FileScanner;
  clock: Clock;
}

// Reunit les deux choses que seul le travailleur peut dire : l'etat de la file
// qu'il depile et la joignabilite du scanner auquel il parle. Rien de plus —
// une source de sante qui irait interroger la base metier finirait par etre la
// vraie sonde de l'application, sans que personne l'ait decide.
export class ScanChainHealthSource implements WorkerHealthSource {
  constructor(private readonly dependencies: ScanChainHealthDependencies) {}

  async read_scan_queue_snapshot(): Promise<ScanQueueSnapshot> {
    return this.dependencies.scan_queue.read_snapshot(this.dependencies.clock.now());
  }

  async probe_clamav(): Promise<ScannerAvailability> {
    return this.dependencies.file_scanner.probe_availability();
  }
}
