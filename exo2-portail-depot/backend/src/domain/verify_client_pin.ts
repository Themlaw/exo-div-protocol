import { is_access_link_usable, type AccessLink } from './access_link';

// Borne appliquee avant tout hachage : le PIN reel ne depasse jamais 12 caracteres,
// et soumettre une chaine enorme a un hachage lent serait un vecteur de deni de service.
export const MAX_SUBMITTED_PIN_LENGTH = 64;

export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pin: string, pin_hash: string): Promise<boolean>;
}

export type PinRejectionReason =
  | 'link_invalid'
  | 'link_blocked'
  | 'pin_length_mismatch'
  | 'submitted_pin_too_long'
  | 'pin_incorrect';

export interface PinVerificationOutcome {
  granted: boolean;
  rejection_reason: PinRejectionReason | null;
  link_after_attempt: AccessLink;
  link_just_became_blocked: boolean;
}

// Rend le lien MIS A JOUR plutot que de le modifier : le domaine ne connait ni
// base ni transaction, et c'est l'appelant qui persiste. `link_just_became_blocked`
// est distingue du simple « le lien est bloque » parce que c'est la BASCULE qui
// declenche une alerte au dashboard de l'avocat — la republier a chaque
// tentative suivante le noierait sous des alertes deja traitees.
export async function verify_client_pin(
  link: AccessLink,
  submitted_pin: string,
  now: Date,
  dependencies: { pin_hasher: PinHasher },
): Promise<PinVerificationOutcome> {
  // Le blocage est teste EN PREMIER, avant meme l'echeance : c'est l'etat qui
  // appelle une action de l'avocat, et le seul que le client ait interet a
  // distinguer.
  if (link.status === 'blocked') {
    return refuse_without_consuming_an_attempt(link, 'link_blocked');
  }

  // Un lien revoque ou expire ne consomme pas d'essai : il n'y a plus rien a
  // proteger, et incrementer un compteur sur un lien mort n'apprendrait rien a
  // personne tout en ecrivant en base a chaque sollicitation.
  if (!is_access_link_usable(link, now)) {
    return refuse_without_consuming_an_attempt(link, 'link_invalid');
  }

  // Avant tout hachage, et c'est tout l'objet de cette borne : un PIN de 10 Mo
  // ferait travailler argon2 sur une entree que rien ne peut rendre valide.
  if (submitted_pin.length > MAX_SUBMITTED_PIN_LENGTH) {
    return consume_an_attempt(link, 'submitted_pin_too_long', now);
  }

  // Une longueur qui ne correspond pas ne peut pas etre le bon PIN : on ne
  // hache donc pas. Mais l'essai est CONSOMME quand meme — refuser sans
  // compter offrirait un oracle gratuit sur la longueur du code, qu'il
  // suffirait alors de balayer sans jamais s'approcher du blocage.
  if (submitted_pin.length !== link.pin_length) {
    return consume_an_attempt(link, 'pin_length_mismatch', now);
  }

  // Le hachage est appele pour TOUT PIN de longueur conforme, juste ou faux :
  // sortir plus tot sur un cas particulier rendrait la reponse mesurablement
  // plus rapide, et le temps de reponse deviendrait un oracle.
  const pin_is_correct: boolean = await dependencies.pin_hasher.verify(
    submitted_pin,
    link.pin_hash,
  );

  if (!pin_is_correct) {
    return consume_an_attempt(link, 'pin_incorrect', now);
  }

  return {
    granted: true,
    rejection_reason: null,
    // Le compteur repart de zero : il compte des echecs CONSECUTIFS sur la vie
    // du lien, et un client qui se souvient de son code n'a pas a trainer ses
    // hesitations passees jusqu'au blocage.
    link_after_attempt: { ...link, failed_pin_attempts: 0 },
    link_just_became_blocked: false,
  };
}

function refuse_without_consuming_an_attempt(
  link: AccessLink,
  rejection_reason: PinRejectionReason,
): PinVerificationOutcome {
  return {
    granted: false,
    rejection_reason,
    link_after_attempt: link,
    link_just_became_blocked: false,
  };
}

function consume_an_attempt(
  link: AccessLink,
  rejection_reason: PinRejectionReason,
  now: Date,
): PinVerificationOutcome {
  const failed_pin_attempts: number = link.failed_pin_attempts + 1;
  const link_just_became_blocked: boolean = failed_pin_attempts >= link.max_pin_attempts;

  return {
    granted: false,
    rejection_reason,
    link_after_attempt: {
      ...link,
      failed_pin_attempts,
      // On detruit le LIEN, jamais la demande : les pieces deja deposees
      // survivent, et l'avocat regenere un couple lien + PIN en un clic.
      status: link_just_became_blocked ? 'blocked' : link.status,
      blocked_at: link_just_became_blocked ? now : link.blocked_at,
    },
    link_just_became_blocked,
  };
}
