import { lawyer_auth_client } from './lawyer_auth_client';

// Trois etats et non deux : « je ne sais pas encore » est un etat a part
// entiere. Le confondre avec « personne » ferait clignoter l'ecran de connexion
// a chaque rechargement d'un avocat pourtant connecte.
export type LawyerSessionState =
  | { readonly status: 'checking' }
  | { readonly status: 'authenticated'; readonly lawyer_email?: string }
  | { readonly status: 'anonymous' };

export function use_lawyer_session(): LawyerSessionState {
  const session = lawyer_auth_client.useSession();

  if (session.isPending) {
    return { status: 'checking' };
  }

  // Une erreur de lecture de session est traitee comme une absence de session :
  // la seule autre issue serait de laisser passer sans savoir, et c'est le
  // backend qui a le dernier mot de toute facon.
  if (session.data === null || session.data === undefined) {
    return { status: 'anonymous' };
  }

  return { status: 'authenticated', lawyer_email: session.data.user.email };
}
