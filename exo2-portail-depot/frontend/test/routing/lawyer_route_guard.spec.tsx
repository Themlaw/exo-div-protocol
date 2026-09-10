import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RequireLawyerSession } from '../../src/routing/require_lawyer_session';
import {
  CLIENT_DEPOSIT_PATH,
  FRONT_ROUTES,
  LAWYER_LOGIN_PATH,
  PUBLIC_FRONT_ROUTE_PATHS,
  guard_front_routes,
  type FrontRouteDeclaration,
} from '../../src/routing/front_routes';
import type { LawyerSessionState } from '../../src/auth/lawyer_session';

const use_lawyer_session = vi.hoisted(() => vi.fn<() => LawyerSessionState>());

vi.mock('../../src/auth/lawyer_session', () => ({ use_lawyer_session }));

function render_guarded_application(entry_path: string): void {
  render(
    <MemoryRouter initialEntries={[entry_path]}>
      <Routes>
        <Route path={LAWYER_LOGIN_PATH} element={<p>Ecran de connexion</p>} />
        <Route path={CLIENT_DEPOSIT_PATH} element={<p>Ecran de depot client</p>} />
        <Route
          path="/deposit-requests"
          element={
            <RequireLawyerSession>
              <p>Mes demandes</p>
            </RequireLawyerSession>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Garde des routes avocat', () => {
  it('renvoie a la connexion quand aucune session ne repond', () => {
    use_lawyer_session.mockReturnValue({ status: 'anonymous' });

    render_guarded_application('/deposit-requests');

    expect(screen.getByText('Ecran de connexion')).toBeInTheDocument();
    expect(screen.queryByText('Mes demandes')).not.toBeInTheDocument();
  });

  it('laisse passer l avocat dont la session est reconnue', () => {
    use_lawyer_session.mockReturnValue({ status: 'authenticated' });

    render_guarded_application('/deposit-requests');

    expect(screen.getByText('Mes demandes')).toBeInTheDocument();
  });

  it('n affiche ni l ecran ni la connexion tant que la session est en cours de verification', () => {
    // La session est lue par une requete : la rendre « absente » en attendant
    // ferait clignoter l'ecran de connexion a CHAQUE rechargement d'un avocat
    // pourtant connecte, et lui ferait croire qu'on l'a deconnecte.
    use_lawyer_session.mockReturnValue({ status: 'checking' });

    render_guarded_application('/deposit-requests');

    expect(screen.queryByText('Mes demandes')).not.toBeInTheDocument();
    expect(screen.queryByText('Ecran de connexion')).not.toBeInTheDocument();
  });

  it('sert le depot client sans jamais reclamer de session avocat', () => {
    // Le client n'a pas de compte : le jeton du lien EST son autorisation.
    use_lawyer_session.mockReturnValue({ status: 'anonymous' });

    render_guarded_application('/deposit/un-jeton-de-lien');

    expect(screen.getByText('Ecran de depot client')).toBeInTheDocument();
  });

  it('garde toute route declaree qui n est pas explicitement publique', () => {
    // Pendant front de `route_protection_by_default.spec.ts` cote backend : une
    // route ajoutee sans y penser est gardee, et l'oubli se paie d'un ecran
    // inaccessible plutot que d'une fuite.
    const guarded = guard_front_routes(FRONT_ROUTES);

    for (const route of guarded) {
      const declaration: FrontRouteDeclaration | undefined = FRONT_ROUTES.find(
        (candidate: FrontRouteDeclaration) => candidate.path === route.path,
      );

      expect(declaration).toBeDefined();
      expect(route.is_guarded).toBe(!PUBLIC_FRONT_ROUTE_PATHS.includes(route.path));
    }

    expect(guarded.map((route) => route.path)).toEqual(
      FRONT_ROUTES.map((declaration: FrontRouteDeclaration) => declaration.path),
    );
    expect(guarded.some((route) => route.is_guarded)).toBe(true);
  });
});
