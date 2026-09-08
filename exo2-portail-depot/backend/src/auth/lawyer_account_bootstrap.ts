import type { NodeEnvironment } from '../shared/node_environment';

// Bornes sur le mot de passe EN CLAIR recu, jamais sur son hachage.
// Minimum a 12 et non au plancher habituel de 8 : c'est install.sh qui genere
// cette valeur, et ce compte est le seul acces avocat de l'installation.
// Maximum a 256 pour la meme raison que le PIN borne a 64 : une chaine enorme
// envoyee a un hachage lent est un vecteur de deni de service.
export const LAWYER_PASSWORD_LENGTH_BOUNDS = { min: 12, max: 256 } as const;

// RFC 5321. Au-dela, aucune boite reelle ne recevra le courrier.
export const MAXIMUM_LAWYER_EMAIL_LENGTH = 254;

// Volontairement large : « quelque chose, une arobase, un domaine pointe, aucun
// espace ». Une regex stricte rejette des adresses valides sans rien protoger de
// plus, et rien ici ne depend de la forme exacte de l'adresse. En particulier
// aucune borne sur le dernier segment : .museum en fait 6, .international 13.
const LAWYER_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LawyerAccountBootstrapViolationField = 'email' | 'plaintext_password';

export interface LawyerAccountBootstrapViolation {
  field: LawyerAccountBootstrapViolationField;
  reason: string;
}

// La violation nomme le champ et la raison, jamais la valeur : cette erreur
// finit dans les journaux de install.sh, et un mot de passe recopie la serait
// aussi.
export class InvalidLawyerAccountBootstrapInputError extends Error {
  readonly violations: readonly LawyerAccountBootstrapViolation[];

  constructor(violations: readonly LawyerAccountBootstrapViolation[]) {
    super(
      `Compte avocat de demonstration invalide : ${violations
        .map((violation: LawyerAccountBootstrapViolation): string =>
          `${violation.field} (${violation.reason})`,
        )
        .join(', ')}`,
    );
    this.name = 'InvalidLawyerAccountBootstrapInputError';
    this.violations = violations;
  }
}

// Levee par l'adaptateur de persistance quand la contrainte d'unicite sur
// l'email se declenche. Traduire le code d'erreur SQL en type metier ici evite
// que la logique d'amorcage connaisse quoi que ce soit a Postgres.
export class LawyerAccountAlreadyExistsError extends Error {
  constructor() {
    super('Un compte avocat porte deja cet email');
    this.name = 'LawyerAccountAlreadyExistsError';
  }
}

export interface LawyerAccountBootstrapInput {
  email: string;
  plaintext_password: string;
}

export interface LawyerAccountBootstrapOutcome {
  // `false` quand le compte existait deja : relancer install.sh ne doit rien
  // dupliquer ni echouer.
  account_was_created: boolean;
}

// `plaintext_password` partout dans ce contrat, jamais `password` : le mot de
// passe y circule en clair, et c'est BetterAuth qui le hache au moment de
// l'ecriture. Un champ nomme `password` des deux cotes rendrait invisible
// l'endroit exact ou la valeur cesse d'etre un secret manipulable.
export interface LawyerAccountRepository {
  find_id_by_email(email: string): Promise<string | null>;
  // Doit lever LawyerAccountAlreadyExistsError si la contrainte d'unicite sur
  // l'email se declenche.
  create(input: LawyerAccountBootstrapInput): Promise<string>;
}

// La contrainte d'unicite porte sur la colonne telle qu'elle est stockee : sans
// normalisation, `Demo@X.fr` et `demo@x.fr` sont deux lignes distinctes et
// l'unicite ne protege plus de rien.
export function normalize_lawyer_email(email: string): string {
  return email.trim().toLowerCase();
}

// Toutes les violations sont collectees, pas seulement la premiere : celui qui
// lance install.sh corrige son environnement en une passe au lieu de decouvrir
// les erreurs une par une.
function collect_bootstrap_violations(
  normalized_email: string,
  plaintext_password: string,
): readonly LawyerAccountBootstrapViolation[] {
  const violations: LawyerAccountBootstrapViolation[] = [];

  if (normalized_email.length > MAXIMUM_LAWYER_EMAIL_LENGTH) {
    violations.push({
      field: 'email',
      reason: `depasse ${MAXIMUM_LAWYER_EMAIL_LENGTH} caracteres`,
    });
  } else if (!LAWYER_EMAIL_SHAPE.test(normalized_email)) {
    violations.push({ field: 'email', reason: "n'a pas la forme d'une adresse" });
  }

  // Aucune regle de complexite volontairement : install.sh genere une phrase de
  // passe de cinq mots, sans majuscule ni caractere special. Une regle de
  // complexite invaliderait cette valeur et pousserait vers plus court.
  if (plaintext_password.length < LAWYER_PASSWORD_LENGTH_BOUNDS.min) {
    violations.push({
      field: 'plaintext_password',
      reason: `plus court que ${LAWYER_PASSWORD_LENGTH_BOUNDS.min} caracteres`,
    });
  } else if (plaintext_password.length > LAWYER_PASSWORD_LENGTH_BOUNDS.max) {
    violations.push({
      field: 'plaintext_password',
      reason: `depasse ${LAWYER_PASSWORD_LENGTH_BOUNDS.max} caracteres`,
    });
  }

  return violations;
}

export async function bootstrap_demo_lawyer_account(
  input: LawyerAccountBootstrapInput,
  dependencies: { lawyer_accounts: LawyerAccountRepository },
): Promise<LawyerAccountBootstrapOutcome> {
  const normalized_email: string = normalize_lawyer_email(input.email);
  const violations: readonly LawyerAccountBootstrapViolation[] = collect_bootstrap_violations(
    normalized_email,
    input.plaintext_password,
  );

  // Avant toute lecture : une entree invalide ne doit pas meme atteindre la base.
  if (violations.length > 0) {
    throw new InvalidLawyerAccountBootstrapInputError(violations);
  }

  const account_to_create: LawyerAccountBootstrapInput = {
    email: normalized_email,
    plaintext_password: input.plaintext_password,
  };

  // Raccourci pour le cas courant — relancer install.sh sur une installation
  // deja amorcee — et rien de plus : entre cette lecture et l'insertion, une
  // autre execution peut creer le compte. La garantie vient de la contrainte
  // d'unicite de la base, pas de ce test.
  const existing_id: string | null =
    await dependencies.lawyer_accounts.find_id_by_email(normalized_email);
  if (existing_id !== null) {
    return { account_was_created: false };
  }

  try {
    await dependencies.lawyer_accounts.create(account_to_create);
  } catch (error: unknown) {
    // Seule la violation d'unicite est absorbee. Attraper largement ferait
    // passer une base injoignable pour un amorcage reussi, et install.sh
    // afficherait un succes sur une installation morte.
    if (error instanceof LawyerAccountAlreadyExistsError) {
      return { account_was_created: false };
    }
    throw error;
  }

  return { account_was_created: true };
}

export class DevelopmentSeedInProductionError extends Error {
  constructor() {
    super("Le seed de developpement ne s'execute pas en production");
    this.name = 'DevelopmentSeedInProductionError';
  }
}

export function assert_development_seed_allowed(node_environment: NodeEnvironment): void {
  // Seed de developpement : donnees d'exemple, jamais executees en production.
  if (node_environment === 'production') {
    throw new DevelopmentSeedInProductionError();
  }
}
