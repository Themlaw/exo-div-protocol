export type AccessLinkStatus = 'active' | 'blocked' | 'revoked';

export interface AccessLink {
  id: string;
  deposit_request_id: string;
  token_hmac: string;
  token_pepper_version: number;
  pin_hash: string;
  pin_length: number;
  max_pin_attempts: number;
  failed_pin_attempts: number;
  status: AccessLinkStatus;
  expires_at: Date;
  created_at: Date;
  blocked_at: Date | null;
  revoked_at: Date | null;
}

// Ce que le client anonyme a le droit de savoir AVANT d'avoir passe le PIN.
// "inexistant" et "expire" partagent volontairement `invalid` : les distinguer
// dirait a un attaquant que le token a existe.
export type PublicAccessLinkState = 'active' | 'invalid' | 'blocked';

// `blocked` est le SEUL etat distingue de `invalid`, et pour une raison qui
// vaut le renseignement donne : sans lui, le client legitime qui s'est trompe
// N fois voit « lien invalide » et croit avoir mal recopie l'adresse. Il doit
// comprendre qu'il faut redemander un lien a l'avocat.
export function resolve_public_access_link_state(
  link: AccessLink | null,
  now: Date,
): PublicAccessLinkState {
  if (link === null) {
    return 'invalid';
  }

  // Avant l'echeance : un lien bloque puis expire reste un lien bloque du point
  // de vue du client, qui a besoin de savoir quoi faire ensuite.
  if (link.status === 'blocked') {
    return 'blocked';
  }

  return is_access_link_usable(link, now) ? 'active' : 'invalid';
}

// Borne EXCLUSIVE : a l'instant exact de `expires_at`, le lien est deja expire.
// Un lien vaut jusqu'a son echeance, pas jusqu'a son echeance incluse — et le
// cas limite est le seul que les deux implementations possibles distinguent,
// donc le seul qui doive etre tranche noir sur blanc.
//
// L'instant est un PARAMETRE, jamais `new Date()` : c'est ce qui rend
// l'expiration observable par un test, et c'est aussi ce qui garantit qu'une
// meme requete evalue tous ses liens sur la meme horloge.
export function is_access_link_usable(link: AccessLink, now: Date): boolean {
  return link.status === 'active' && now.getTime() < link.expires_at.getTime();
}
