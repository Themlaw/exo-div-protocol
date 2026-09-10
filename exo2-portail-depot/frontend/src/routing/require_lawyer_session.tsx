import type { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { use_lawyer_session, type LawyerSessionState } from '../auth/lawyer_session';
import { LAWYER_LOGIN_PATH } from './front_routes';

export interface RequireLawyerSessionProps {
  readonly children: ReactNode;
}

export function RequireLawyerSession({
  children,
}: RequireLawyerSessionProps): ReactElement | null {
  const session: LawyerSessionState = use_lawyer_session();
  const location = useLocation();

  // Rien du tout tant que la session est en cours de lecture. Un ecran de
  // connexion affiche « au cas ou » serait un mensonge d'une demi-seconde, et
  // c'est celui que l'utilisateur retient.
  if (session.status === 'checking') {
    return null;
  }

  if (session.status === 'anonymous') {
    // `state` porte la destination : apres connexion, l'avocat revient la ou il
    // allait plutot que sur un tableau de bord generique.
    return <Navigate to={LAWYER_LOGIN_PATH} replace state={{ intended_path: location.pathname }} />;
  }

  return <>{children}</>;
}
