import { NotImplementedError } from '../domain/not_implemented';

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
  _failure_timestamps: readonly Date[],
  _now: Date,
  _window_seconds: number,
): number {
  throw new NotImplementedError('count_failed_attempts_within_window');
}

// Un X-Forwarded-For est une liste dont le client controle entierement le
// debut. On part donc de la DROITE et on remonte tant qu'on traverse des relais
// declares de confiance : la premiere adresse non fiable est la vraie. Prendre
// la plus a gauche laisserait n'importe qui changer d'identite a chaque requete.
// Meme regle : quand la chaine est plus courte que le nombre de sauts declares,
// ou qu'une entrée n'est pas une adresse exploitable, on retombe sur l'adresse
// directe de la connexion — la seule que le client ne peut pas ecrire. Un repli
// permissif rendrait la limite contournable en envoyant une chaine tronquee.
export function resolve_trusted_client_ip(
  _forwarded_for_chain: readonly string[],
  _direct_remote_address: string,
  _trusted_proxy_hop_count: number,
): string {
  throw new NotImplementedError('resolve_trusted_client_ip');
}

export function compute_login_backoff_delay_seconds(
  _consecutive_failed_attempts: number,
): number {
  throw new NotImplementedError('compute_login_backoff_delay_seconds');
}
