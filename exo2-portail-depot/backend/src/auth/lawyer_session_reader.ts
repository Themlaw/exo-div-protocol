import type { IncomingHttpHeaders } from 'node:http';

// Le garde n'a pas a connaitre BetterAuth : il a besoin de savoir si la requete
// porte une session avocat valide, rien de plus. Cette frontiere permet aussi
// de tester le garde sans base ni bibliotheque d'authentification.
export const LAWYER_SESSION_READER: unique symbol = Symbol('LAWYER_SESSION_READER');

export interface LawyerSession {
  user_id: string;
  email: string;
  expires_at: Date;
}

// Le type de Node lui-meme, et pas une reecriture a nous : ce sont exactement
// les en-tetes que `request.headers` fournit, et c'est aussi ce qu'attend
// `fromNodeHeaders`. Une variante `Readonly<Record<string, string | readonly
// string[]>>` se lisait mieux mais n'etait acceptee ni d'un cote ni de
// l'autre, et obligeait a une assertion de type a chaque bout de la chaine.
export type IncomingRequestHeaders = IncomingHttpHeaders;

export interface LawyerSessionReader {
  // Rend `null` pour toute session absente, expiree, revoquee ou forgee : le
  // garde ne distingue pas ces cas, et l'appelant non plus. Distinguer
  // « cookie invalide » de « session expiree » renseignerait un attaquant sur
  // l'etat du serveur sans rien apporter a l'utilisateur legitime.
  read_lawyer_session(headers: IncomingRequestHeaders): Promise<LawyerSession | null>;
}
