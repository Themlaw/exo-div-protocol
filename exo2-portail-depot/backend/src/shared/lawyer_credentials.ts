// Source unique des regles sur les identifiants avocat. Ni dans `config/`, qui
// lit l'environnement mais n'a pas a definir ce qu'est un mot de passe valide,
// ni dans `auth/`, dont `db/schema/` n'a pas a dependre pour ecrire une
// contrainte. Les trois couches importent d'ici.

// Bornes sur le mot de passe EN CLAIR recu, jamais sur son hachage.
// Minimum a 12 et non au plancher habituel de 8 : c'est install.sh qui genere
// cette valeur, et ce compte est le seul acces avocat de l'installation.
// Maximum a 256 pour la meme raison que le PIN borne a 64 : une chaine enorme
// envoyee a un hachage lent est un vecteur de deni de service.
export const LAWYER_PASSWORD_LENGTH_BOUNDS = { min: 12, max: 256 } as const;

// RFC 5321. Au-dela, aucune boite reelle ne recevra le courrier.
export const MAXIMUM_LAWYER_EMAIL_LENGTH = 254;

// Volontairement large : « quelque chose, une arobase, un domaine pointe, aucun
// espace ». Une regex stricte rejette des adresses valides sans rien proteger de
// plus. En particulier aucune borne sur le dernier segment : .museum en fait 6,
// .international 13, et la limite reelle est celle d'un label DNS, 63.
const LAWYER_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// BetterAuth met l'email en minuscules a l'ecriture comme a la lecture, mais ne
// le trimme jamais (verifie dans la version installee). On normalise donc PLUS
// que lui, ce qui est le sens sur : les variantes se rabattent sur une seule
// valeur. Normaliser moins que lui aurait fabrique la faille.
//
// L'enjeu depasse l'unicite de `auth.user.email` : la meme valeur sert de clef
// au compteur d'echecs par compte, ou deux variantes de casse donneraient deux
// compteurs distincts, donc un contournement du backoff.
export function normalize_lawyer_email(email: string): string {
  return email.trim().toLowerCase();
}

export function has_lawyer_email_shape(normalized_email: string): boolean {
  return LAWYER_EMAIL_SHAPE.test(normalized_email);
}

export function is_lawyer_email_too_long(normalized_email: string): boolean {
  return normalized_email.length > MAXIMUM_LAWYER_EMAIL_LENGTH;
}

export type LawyerPasswordLengthViolation = 'too_short' | 'too_long' | null;

// Aucune regle de complexite, volontairement : install.sh genere une phrase de
// passe de cinq mots, sans majuscule ni caractere special. Une regle de
// complexite invaliderait cette valeur et pousserait vers plus court.
export function find_lawyer_password_length_violation(
  plaintext_password: string,
): LawyerPasswordLengthViolation {
  if (plaintext_password.length < LAWYER_PASSWORD_LENGTH_BOUNDS.min) {
    return 'too_short';
  }
  if (plaintext_password.length > LAWYER_PASSWORD_LENGTH_BOUNDS.max) {
    return 'too_long';
  }
  return null;
}
