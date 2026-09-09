import { is_access_link_usable, type AccessLink } from './access_link';

export interface DepositSession {
  id: string;
  access_link_id: string;
  created_at: Date;
  expires_at: Date;
}

// Le domaine decide QUAND la session vit, pas QUI elle est : l'identite est
// tiree a la persistance, avec le jeton qui l'accompagne. Rendre un `id` vide
// pour respecter la forme complete ferait circuler une session a moitie
// construite, que rien n'empecherait d'utiliser telle quelle.
export type NewDepositSession = Omit<DepositSession, 'id'>;

export type DepositSessionRejectionReason =
  | 'session_expired'
  | 'session_belongs_to_another_link'
  | 'access_link_no_longer_usable';

export interface DepositSessionUsability {
  usable: boolean;
  rejection_reason: DepositSessionRejectionReason | null;
}

// L'echeance est BORNEE par celle du lien, jamais additionnee : sinon un client
// qui deverrouille juste avant l'echeance repartirait avec une session valide apres.
export function open_client_deposit_session(
  link: AccessLink,
  requested_lifetime_seconds: number,
  now: Date,
): NewDepositSession {
  const requested_expiry: number = now.getTime() + requested_lifetime_seconds * 1000;

  return {
    access_link_id: link.id,
    created_at: now,
    // La plus courte des deux echeances gagne. C'est la deuxieme des trois
    // horloges du produit — lien, session, presigned — et la regle est la meme
    // pour toutes : chacune est bornee par la precedente.
    expires_at: new Date(Math.min(requested_expiry, link.expires_at.getTime())),
  };
}

// Relue A CHAQUE REQUETE, jamais verifiee une fois pour toutes : c'est ce qui
// fait qu'une revocation par l'avocat prend effet au prochain appel, et non a
// l'expiration de la session. Un jeton autoportant ne pourrait pas tenir cette
// promesse.
export function is_deposit_session_usable(
  session: DepositSession,
  link: AccessLink,
  now: Date,
): DepositSessionUsability {
  // L'appartenance D'ABORD : une session presentee avec un autre lien que le
  // sien est une tentative de rapprochement, pas une session fatiguee.
  // Repondre sur son echeance reviendrait a renseigner sur une session qui
  // n'est pas celle-la.
  if (session.access_link_id !== link.id) {
    return refuse('session_belongs_to_another_link');
  }

  // Le lien avant la session : c'est lui qui porte l'autorisation, elle n'en
  // est qu'un derive. Expire, revoque ou bloque, il emporte tout ce qui en
  // decoule — et une seule raison est rendue pour les trois, le client n'ayant
  // pas a savoir laquelle.
  if (!is_access_link_usable(link, now)) {
    return refuse('access_link_no_longer_usable');
  }

  if (now.getTime() >= session.expires_at.getTime()) {
    return refuse('session_expired');
  }

  return { usable: true, rejection_reason: null };
}

function refuse(rejection_reason: DepositSessionRejectionReason): DepositSessionUsability {
  return { usable: false, rejection_reason };
}
