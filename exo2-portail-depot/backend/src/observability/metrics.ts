import type { ActivityEventType } from '../domain/activity_event';

export const METRICS_REGISTRY: unique symbol = Symbol('METRICS_REGISTRY');

// Les deux surfaces qui refusent pour cause de cadence. Un label ferme plutot
// que deux metriques : « combien de refus au total » reste une somme, et
// « lesquels » reste une ventilation.
export const RATE_LIMITED_SURFACES = ['client_pin', 'lawyer_login'] as const;
export type RateLimitedSurface = (typeof RATE_LIMITED_SURFACES)[number];

export type ScannerAvailability = 'available' | 'unavailable';

// Ce que la file de scan sait dire d'elle-meme a un instant donne. Ce sont des
// JAUGES : on les lit, on ne les compte pas, et la valeur d'hier n'a aucun
// sens.
export interface ScanQueueSnapshot {
  pending_job_count: number;
  running_job_count: number;
  failed_job_count: number;
  // Zero quand rien n'attend. C'est la mesure qui porte l'alerte : elle est la
  // SEULE panne ou toutes les sondes d'infra sont vertes et ou le produit ne
  // marche plus — les pieces arrivent, rien n'est publie, aucune erreur.
  oldest_pending_job_age_seconds: number;
}

// La sante que seul le processus travailleur peut rapporter : il possede la
// file, et c'est lui qui parle a clamd.
export interface WorkerHealthSource {
  read_scan_queue_snapshot(): Promise<ScanQueueSnapshot>;
  probe_clamav(): Promise<ScannerAvailability>;
}

export interface RenderedMetrics {
  body: string;
  content_type: string;
}

// Des methodes NOMMEES plutot qu'un `count(nom, labels)` generique : le nom
// d'une metrique ne se corrige pas apres coup — une faute de frappe cree
// silencieusement une seconde serie, et l'ancienne s'arrete sans que rien ne le
// signale. Ici, le compilateur les enumere.
//
// Le port ne parle nulle part de Prometheus : c'est ce qui fait que changer de
// collecteur reste un fichier d'adaptateur.
export interface MetricsRegistry {
  // Un compteur par type d'evenement metier, et la cardinalite est bornee par
  // l'enumeration FERMEE du journal : jamais d'identifiant de demande, de jeton
  // ni de nom de fichier en label.
  count_activity_event(type: ActivityEventType): void;

  // Le jeton inconnu ne peut pas entrer au journal — il ne designe aucune
  // demande — et c'etait jusqu'ici un simple `warn`. C'est pourtant le signal
  // d'un balayage de jetons, donc il lui fallait un compteur.
  count_unknown_access_link_attempt(): void;

  count_rate_limited_request(surface: RateLimitedSurface): void;

  // Branche les jauges du travailleur, et n'est appelee QUE par lui. L'API
  // partage la meme base et pourrait techniquement les lire : les exposer des
  // deux cotes ferait doubler un `sum()` sur la profondeur de file. La decision
  // « qui possede la file » vit donc a la racine du processus, en une ligne
  // visible, plutot que dans un reglage.
  attach_worker_health_source(source: WorkerHealthSource): void;

  // Rendu a la demande du collecteur, jamais tenu en cache : une metrique lue
  // dans un cache serait une metrique qui ment sur son age.
  render(): Promise<RenderedMetrics>;
}
