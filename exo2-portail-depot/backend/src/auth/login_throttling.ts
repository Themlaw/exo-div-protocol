import { isIP } from 'node:net';

// Pas de verrouillage de compte : contrairement au PIN d'un lien, un avocat
// verrouille n'a personne pour le debloquer, et connaitre son email suffirait
// a le mettre dehors. On ralentit, on ne ferme jamais.
export const LOGIN_BACKOFF_BOUNDS = {
  attempts_before_backoff: 3,
  initial_delay_seconds: 1,
  max_delay_seconds: 300,
} as const;

// Volontairement HAUTE : c'est un garde-fou anti-balayage, pas la protection
// principale — celle-ci est le backoff par compte. Deux raisons :
// 1. un cabinet entier est derriere une seule IP publique ; une limite serree
//    transformerait les fautes de frappe d'un collaborateur en panne pour tous ;
// 2. le 443 du serveur est en passthrough SNI, donc le proxy frontal ne voit
//    pas de HTTP et ne peut pas ajouter de X-Forwarded-For : toutes les
//    requetes risquent de partager l'adresse du proxy. Une limite serree
//    deviendrait alors un deni de service global, declenchable par n'importe qui.
export const LOGIN_IP_RATE_LIMIT_BOUNDS = {
  max_failed_attempts_per_window: 100,
  window_seconds: 900,
} as const;

// On ne compte que les ECHECS. Compter les requetes penaliserait un cabinet
// actif dont tout le monde se connecte correctement.
//
// Et contrairement au compteur par compte, celui par IP ne se remet PAS a zero
// sur une reussite : il decroit avec le temps. Sinon un attaquant possedant un
// compte legitime alterne N tentatives sur le compte vise et une connexion
// reussie sur le sien, et son budget repart a zero indefiniment.
// Regle en cas de doute : on sur-compte plutot que de sous-compter. Un echec
// pile a la limite de la fenetre est compte, et un horodatage dans le futur
// (horloge decalee) aussi. Sous-compter ouvrirait la limite ; sur-compter ne
// fait que ralentir un peu plus tot, ce qui est sans consequence puisque la
// limite par IP est volontairement haute.
export function count_failed_attempts_within_window(
  failure_timestamps: readonly Date[],
  now: Date,
  window_seconds: number,
): number {
  const window_start_timestamp: number = now.getTime() - window_seconds * 1000;

  return failure_timestamps.filter((failure_timestamp: Date): boolean => {
    // Borne inclusive, et un horodatage futur (horloge decalee) est traite
    // comme recent : sous-compter ouvrirait la limite, sur-compter ne fait
    // que ralentir un peu plus tot.
    return failure_timestamp.getTime() >= window_start_timestamp;
  }).length;
}

// Un X-Forwarded-For est une liste dont le client controle entierement le
// debut. On part donc de la DROITE et on remonte tant qu'on traverse des relais
// declares de confiance : la premiere adresse non fiable est la vraie. Prendre
// la plus a gauche laisserait n'importe qui changer d'identite a chaque requete.
// Meme regle : quand la chaine est plus courte que le nombre de sauts declares,
// ou qu'une entrée n'est pas une adresse exploitable, on retombe sur l'adresse
// directe de la connexion — la seule que le client ne peut pas ecrire. Un repli
// permissif rendrait la limite contournable en envoyant une chaine tronquee.
// Rend `null` quand aucune adresse stockable ne peut etre etablie : l'appelant
// doit alors renoncer a compter par adresse plutot qu'ecrire une valeur brute.
export function resolve_trusted_client_ip(
  forwarded_for_chain: readonly string[],
  direct_remote_address: string,
  trusted_proxy_hop_count: number,
): string | null {
  // Zero saut de confiance declare, ou une chaine plus courte que le nombre de
  // sauts declares : aucune entree de la chaine n'est fiable, on retombe sur
  // l'adresse directe.
  // `Number.isSafeInteger` d'abord, et pas seulement les deux comparaisons qui
  // suivent : `NaN <= 0` est faux ET `NaN > length` est faux, donc un NaN
  // franchissait les deux gardes, `chain[NaN]` valait `undefined` et `.trim()`
  // levait. Une TypeError ici, c'est un 500 sur CHAQUE tentative de connexion.
  if (
    !Number.isSafeInteger(trusted_proxy_hop_count) ||
    trusted_proxy_hop_count <= 0 ||
    trusted_proxy_hop_count > forwarded_for_chain.length
  ) {
    return normalize_client_ip(direct_remote_address);
  }

  const candidate_index: number =
    forwarded_for_chain.length - trusted_proxy_hop_count;
  const candidate_ip: string | null = normalize_client_ip(
    forwarded_for_chain[candidate_index] ?? '',
  );

  // Une entree qui n'est pas une adresse exploitable n'est pas retenue comme
  // identite de limitation : on ne fait pas confiance a une valeur non conforme,
  // meme situee au bon endroit de la chaine.
  return candidate_ip ?? normalize_client_ip(direct_remote_address);
}

export function compute_login_backoff_delay_seconds(
  consecutive_failed_attempts: number,
): number {
  if (consecutive_failed_attempts < LOGIN_BACKOFF_BOUNDS.attempts_before_backoff) {
    return 0;
  }

  const attempts_past_threshold: number =
    consecutive_failed_attempts - LOGIN_BACKOFF_BOUNDS.attempts_before_backoff;

  // Croissance exponentielle a partir du seuil, plafonnee : on ralentit, on ne
  // ferme jamais, et le delai ne doit jamais depasser le plafond meme pour un
  // tres grand nombre de tentatives (ni devenir negatif par depassement numerique).
  const exponential_delay_seconds: number =
    LOGIN_BACKOFF_BOUNDS.initial_delay_seconds * 2 ** attempts_past_threshold;

  return Math.min(exponential_delay_seconds, LOGIN_BACKOFF_BOUNDS.max_delay_seconds);
}

// --- Contrat issu de la revue de securite du 2026-09-08 ---
// Le backoff par compte, seul, produisait le verrouillage qu'il devait eviter :
// le compteur ne decroissait jamais, donc douze mauvais mots de passe puis une
// requete toutes les cinq minutes suffisaient a fermer definitivement le seul
// compte avocat de l'installation. Trois couches distinctes le remplacent.

// Au-dela de ce silence, un compteur d'echecs est considere comme retombe a
// zero. Sans decroissance, une echelle de backoff ne redescend jamais et
// devient un verrou permanent.
export const LOGIN_FAILURE_DECAY_SECONDS = 3600;

export function decay_consecutive_failed_attempts(
  consecutive_failed_attempts: number,
  seconds_since_last_failure: number,
): number {
  // Une horloge qui recule ne fabrique pas d'echecs : on ne fait que retirer du
  // compteur, jamais en ajouter.
  if (seconds_since_last_failure >= LOGIN_FAILURE_DECAY_SECONDS) {
    return 0;
  }
  return consecutive_failed_attempts;
}

export type LoginThrottleOutcome =
  | { kind: 'allow' }
  // Retarde la reponse mais evalue quand meme les identifiants : c'est ce qui
  // garantit qu'une presentation d'identifiants CORRECTS n'est jamais refusee.
  | { kind: 'delay'; delay_seconds: number }
  | { kind: 'refuse'; retry_after_seconds: number };

export interface LoginThrottleState {
  // Couche principale. L'attaquant est sur SON adresse, pas sur celle de la
  // victime : refuser ici ne ferme rien pour l'avocat legitime.
  account_ip_failed_attempts: number;
  seconds_since_account_ip_last_failure: number;

  // Couche anti-rotation d'adresse. C'est la seule qui puisse atteindre un
  // avocat legitime, donc la seule qui ne doit JAMAIS refuser.
  account_failed_attempts: number;
  seconds_since_account_last_failure: number;

  // Couche anti-balayage, volontairement haute.
  ip_failed_attempts_in_window: number;
}

export function decide_login_throttle(state: LoginThrottleState): LoginThrottleOutcome {
  // Anti-balayage d'abord : c'est la seule couche qui protege les comptes qu'on
  // ne connait pas encore.
  if (
    state.ip_failed_attempts_in_window >=
    LOGIN_IP_RATE_LIMIT_BOUNDS.max_failed_attempts_per_window
  ) {
    return { kind: 'refuse', retry_after_seconds: LOGIN_IP_RATE_LIMIT_BOUNDS.window_seconds };
  }

  // Couche principale : le couple (compte, adresse). Refuser ici est sans
  // danger — l'attaquant est sur SON adresse, pas sur celle de la victime, donc
  // ce refus ne peut pas fermer le compte a son titulaire legitime.
  const account_ip_attempts: number = decay_consecutive_failed_attempts(
    state.account_ip_failed_attempts,
    state.seconds_since_account_ip_last_failure,
  );
  const account_ip_delay_seconds: number =
    compute_login_backoff_delay_seconds(account_ip_attempts);
  if (account_ip_delay_seconds > 0) {
    return { kind: 'refuse', retry_after_seconds: account_ip_delay_seconds };
  }

  // Couche anti-rotation d'adresse. Elle est la seule a pouvoir atteindre un
  // avocat legitime — c'est exactement le verrou permanent que la revue a
  // demontre — donc elle RETARDE et ne refuse jamais. Le ralentissement suffit :
  // il s'applique aussi a l'attaquant, qui n'obtient rien de plus.
  const account_attempts: number = decay_consecutive_failed_attempts(
    state.account_failed_attempts,
    state.seconds_since_account_last_failure,
  );
  const account_delay_seconds: number = compute_login_backoff_delay_seconds(account_attempts);
  if (account_delay_seconds > 0) {
    return { kind: 'delay', delay_seconds: account_delay_seconds };
  }

  return { kind: 'allow' };
}

// `isIP` de Node est plus permissif que le type `inet` de Postgres et ne
// canonicalise rien. Deux consequences mesurees : `fe80::1%eth0` passe isIP et
// fait echouer l'INSERT du compteur — donc l'echec n'est pas compte — et
// `::ffff:1.2.3.4` est distinct de `1.2.3.4` pour Postgres, donc un meme client
// occupe deux compteurs selon qu'il arrive par la socket ou par l'en-tete.
//
// Rend `null` quand la valeur n'est pas une adresse stockable : l'appelant doit
// alors traiter l'identite comme inconnue, jamais ecrire la valeur brute.
// `::ffff:1.2.3.4` et `1.2.3.4` sont deux valeurs distinctes pour le type inet
// de Postgres : sans ce rabattement, un meme client occuperait deux compteurs
// selon qu'il arrive par la socket double pile ou par l'en-tete.
const IPV4_MAPPED_IN_IPV6_SHAPE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

export function normalize_client_ip(value: string): string | null {
  const trimmed_value: string = value.trim();

  // Un identifiant de zone (`fe80::1%eth0`) passe isIP mais fait lever
  // « invalid input syntax for type inet ». Or req.socket.remoteAddress produit
  // exactement cette forme pour un pair IPv6 lien-local : l'INSERT du compteur
  // echouerait, donc l'echec ne serait pas compte.
  if (trimmed_value.includes('%')) {
    return null;
  }

  const ip_version: number = isIP(trimmed_value);
  if (ip_version === 0) {
    return null;
  }
  if (ip_version === 4) {
    return trimmed_value;
  }

  const lowercased_ipv6: string = trimmed_value.toLowerCase();
  const mapped_ipv4 = IPV4_MAPPED_IN_IPV6_SHAPE.exec(lowercased_ipv6);
  if (mapped_ipv4 !== null && isIP(mapped_ipv4[1]) === 4) {
    return mapped_ipv4[1];
  }

  return lowercased_ipv6;
}
