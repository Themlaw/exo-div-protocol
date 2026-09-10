import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

import { DepositRequestDashboardScreen } from '../screens/deposit_request_dashboard';
import { LawyerLoginScreen } from '../screens/lawyer_login';
import { MyDepositRequestsScreen } from '../screens/my_deposit_requests';
import { NewDepositRequestScreen } from '../screens/new_deposit_request';
import { ScreenUnderConstruction } from '../screens/screen_under_construction';
import { RequireLawyerSession } from './require_lawyer_session';

export const LAWYER_LOGIN_PATH = '/login';
export const LAWYER_DEPOSIT_REQUESTS_PATH = '/deposit-requests';
export const LAWYER_NEW_DEPOSIT_REQUEST_PATH = '/deposit-requests/new';
export const LAWYER_DEPOSIT_REQUEST_PATH = '/deposit-requests/:deposit_request_id';
// Pas de francais dans les URL, et pas de mot qui trahisse le dossier : le
// client recoit ce lien par un canal qu'on ne maitrise pas.
export const CLIENT_DEPOSIT_PATH = '/deposit/:token';

// La liste blanche est ecrite une fois, ici, et elle est courte a dessein :
// tout le reste est garde SANS avoir a le dire. Une route ajoutee par distraction
// devient inaccessible plutot que publique.
export const PUBLIC_FRONT_ROUTE_PATHS: readonly string[] = [
  LAWYER_LOGIN_PATH,
  CLIENT_DEPOSIT_PATH,
];

export interface FrontRouteDeclaration {
  readonly path: string;
  readonly element: ReactElement;
}

export interface GuardedFrontRoute {
  readonly path: string;
  readonly element: ReactElement;
  readonly is_guarded: boolean;
}

export const FRONT_ROUTES: readonly FrontRouteDeclaration[] = [
  {
    path: '/',
    element: <Navigate to={LAWYER_DEPOSIT_REQUESTS_PATH} replace />,
  },
  {
    path: LAWYER_LOGIN_PATH,
    element: <LawyerLoginScreen />,
  },
  {
    path: LAWYER_DEPOSIT_REQUESTS_PATH,
    element: <MyDepositRequestsScreen />,
  },
  {
    path: LAWYER_NEW_DEPOSIT_REQUEST_PATH,
    element: <NewDepositRequestScreen />,
  },
  {
    path: LAWYER_DEPOSIT_REQUEST_PATH,
    element: <DepositRequestDashboardScreen />,
  },
  {
    path: CLIENT_DEPOSIT_PATH,
    element: <ScreenUnderConstruction screen_name="Depot de pieces" />,
  },
];

// Le pendant front de `route_protection_by_default.spec.ts` : c'est CETTE
// fonction qui decide, et non chaque declaration, pour qu'aucune route ne
// puisse etre servie sans etre passee par la question.
export function guard_front_routes(
  declarations: readonly FrontRouteDeclaration[],
): readonly GuardedFrontRoute[] {
  return declarations.map((declaration: FrontRouteDeclaration): GuardedFrontRoute => {
    const is_guarded: boolean = !PUBLIC_FRONT_ROUTE_PATHS.includes(declaration.path);

    return {
      path: declaration.path,
      is_guarded,
      element: is_guarded ? (
        <RequireLawyerSession>{declaration.element}</RequireLawyerSession>
      ) : (
        declaration.element
      ),
    };
  });
}
