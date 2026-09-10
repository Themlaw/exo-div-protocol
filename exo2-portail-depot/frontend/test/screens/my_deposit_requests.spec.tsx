import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';

import { MyDepositRequestsScreen } from '../../src/screens/my_deposit_requests';
import {
  LAWYER_DEPOSIT_REQUESTS_PATH,
  LAWYER_LOGIN_PATH,
  LAWYER_NEW_DEPOSIT_REQUEST_PATH,
} from '../../src/routing/front_routes';
import type { DepositRequestOverview } from '../../src/api/contracts';
import { render_screen } from '../helpers/render_screen';

const QUIET_ACTIVITY = {
  has_problem: false,
  infected_count: 0,
  rejected_count: 0,
  rejected_pin_attempt_count: 0,
  unusable_link_attempt_count: 0,
  was_link_blocked: false,
} as const;

const MARTIN_OVERVIEW: DepositRequestOverview = {
  id: 'dossier-martin',
  title: 'Dossier Martin, pieces 2026',
  status: 'incomplete',
  expected_document_count: 4,
  deposited_document_count: 2,
  link_expires_at: '2026-09-24T09:00:00.000Z',
  created_at: '2026-09-10T09:00:00.000Z',
  activity_summary: QUIET_ACTIVITY,
};

function render_my_deposit_requests(): void {
  render_screen(<MyDepositRequestsScreen />, {
    route_path: LAWYER_DEPOSIT_REQUESTS_PATH,
    extra_routes: (
      <>
        <Route path={LAWYER_LOGIN_PATH} element={<p>Ecran de connexion</p>} />
        <Route path={LAWYER_NEW_DEPOSIT_REQUEST_PATH} element={<p>Nouvelle demande</p>} />
      </>
    ),
  });
}

describe('Ecran Mes demandes', () => {
  const fetch_spy = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch_spy);
  });

  afterEach(() => {
    fetch_spy.mockReset();
    vi.unstubAllGlobals();
  });

  it('annonce le chargement avant d avoir la moindre demande', () => {
    fetch_spy.mockReturnValue(new Promise<Response>(() => {}));

    render_my_deposit_requests();

    expect(screen.getByRole('status')).toHaveTextContent('Chargement de vos demandes');
  });

  it('resume chaque demande en un coup d oeil', async () => {
    fetch_spy.mockResolvedValue(json_response(200, [MARTIN_OVERVIEW]));

    render_my_deposit_requests();

    const entry: HTMLElement = await screen.findByRole('link', {
      name: /Dossier Martin, pieces 2026/,
    });

    // Le compteur, le statut et l'echeance sur la MEME ligne que le titre :
    // c'est ce qui permet de balayer dix dossiers sans en ouvrir un seul.
    expect(entry).toHaveTextContent('2 / 4 pieces');
    expect(entry).toHaveTextContent('Incomplet');
    expect(entry).toHaveTextContent('24/09/2026');
    expect(entry).toHaveAttribute('href', '/deposit-requests/dossier-martin');
  });

  it('propose de creer quand il n y a rien a montrer', async () => {
    fetch_spy.mockResolvedValue(json_response(200, []));

    render_my_deposit_requests();

    // Un ecran vide sans issue se lit comme une panne.
    expect(await screen.findByText('Aucune demande en cours')).toBeInTheDocument();

    // Deux fois la meme action, et c'est voulu : celle de l'en-tete ne bouge
    // jamais, celle du vide est la ou le regard tombe quand la liste est vide.
    const creation_links: HTMLElement[] = screen.getAllByRole('link', {
      name: 'Faire une nouvelle demande',
    });

    expect(creation_links).toHaveLength(2);
    for (const creation_link of creation_links) {
      expect(creation_link).toHaveAttribute('href', '/deposit-requests/new');
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('laisse reessayer apres une panne, et rappelle vraiment l API', async () => {
    fetch_spy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render_my_deposit_requests();
    await screen.findByRole('alert');

    fetch_spy.mockResolvedValue(json_response(200, [MARTIN_OVERVIEW]));
    await userEvent.click(screen.getByRole('button', { name: 'Reessayer' }));

    expect(await screen.findByText(/Dossier Martin/)).toBeInTheDocument();
    expect(fetch_spy).toHaveBeenCalledTimes(2);
  });

  it('ramene a la connexion quand la session a expire, et pour ce seul cas', async () => {
    fetch_spy.mockResolvedValue(json_response(401, { message: 'Non authentifie' }));

    render_my_deposit_requests();

    // Afficher « Reessayer » sur un 401 ferait tourner l'avocat en rond : la
    // requete echouera identiquement tant qu'il ne s'est pas reconnecte.
    await waitFor(() => {
      expect(screen.getByText('Ecran de connexion')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
