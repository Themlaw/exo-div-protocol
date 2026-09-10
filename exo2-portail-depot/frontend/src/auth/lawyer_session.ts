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

// La garde est le SEUL lecteur du magasin de session, et le magasin de
// better-auth est un atome nanostores : il se demonte des que plus personne ne
// le lit — c'est-a-dire pendant que le formulaire de connexion est affiche.
// Demonte, il fige sa derniere valeur (« anonyme ») et n'ecoute plus le signal
// emis par la connexion reussie. Naviguer vers une route gardee sans avoir relu
// la session fait donc lire a la garde qui se remonte une valeur perimee : elle
// renvoie au formulaire, et l'avocat doit se connecter deux fois.
//
// Appeler ce hook depuis le formulaire remonte le magasin tant qu'il est
// affiche, et la relecture qu'il rend est attendue avant de naviguer.
export function use_lawyer_session_reload(): () => Promise<void> {
  return lawyer_auth_client.useSession().refetch;
}
