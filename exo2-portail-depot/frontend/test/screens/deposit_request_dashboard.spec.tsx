import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DepositRequestDashboardScreen } from '../../src/screens/deposit_request_dashboard';
import { LAWYER_DEPOSIT_REQUEST_PATH } from '../../src/routing/front_routes';
import {
  ACTIVITY_EVENT_TYPES,
  type ActivityEventType,
  type DepositRequestDetail,
  type LawyerActivityPage,
} from '../../src/api/contracts';
import { render_screen } from '../helpers/render_screen';

const DEPOSIT_REQUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const DASHBOARD_ENTRY_PATH = `/deposit-requests/${DEPOSIT_REQUEST_ID}`;

const DETAIL: DepositRequestDetail = {
  id: DEPOSIT_REQUEST_ID,
  title: 'Dossier Martin, pieces 2026',
  status: 'incomplete',
  security_policy: { max_pin_attempts: 5, link_lifetime_days: 14, pin_length: 6 },
  created_at: '2026-09-10T09:00:00.000Z',
  link_expires_at: '2026-09-24T09:00:00.000Z',
  expected_documents: [
    {
      id: 'doc-identite',
      label: "Piece d'identite",
      position: 1,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 20 * 1024 * 1024,
      deposited_file: {
        id: 'fichier-identite',
        display_filename: 'cni.pdf',
        declared_mime_type: 'application/pdf',
        size_bytes: 51200,
        status: 'clean',
        uploaded_at: '2026-09-11T10:00:00.000Z',
        scanned_at: '2026-09-11T10:00:05.000Z',
      },
    },
    {
      id: 'doc-impots',
      label: "Avis d'imposition",
      position: 2,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 20 * 1024 * 1024,
      deposited_file: null,
    },
    {
      id: 'doc-domicile',
      label: 'Justificatif de domicile',
      position: 3,
      allowed_mime_types: ['image/jpeg'],
      max_size_bytes: 5 * 1024 * 1024,
      deposited_file: {
        id: 'fichier-domicile',
        display_filename: 'edf.jpg',
        declared_mime_type: 'image/jpeg',
        size_bytes: 120000,
        status: 'infected',
        uploaded_at: '2026-09-11T11:00:00.000Z',
        scanned_at: '2026-09-11T11:00:07.000Z',
      },
    },
  ],
};

const QUIET_ACTIVITY: LawyerActivityPage = { events: [], has_more: false };

function render_dashboard(): void {
  render_screen(<DepositRequestDashboardScreen />, {
    route_path: LAWYER_DEPOSIT_REQUEST_PATH,
    entry_path: DASHBOARD_ENTRY_PATH,
  });
}

describe('Dashboard d une demande', () => {
  const fetch_spy = vi.fn<typeof fetch>();
  const open_window = vi.fn<(url: string, target: string) => null>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch_spy);
    vi.stubGlobal('open', open_window);
    fetch_spy.mockImplementation(default_api_responses());
  });

  afterEach(() => {
    fetch_spy.mockReset();
    open_window.mockReset();
    vi.unstubAllGlobals();
  });

  it('donne a chaque document attendu son etat', async () => {
    render_dashboard();

    const identity_row: HTMLElement = await screen.findByRole('listitem', {
      name: "Piece d'identite",
    });

    expect(within(identity_row).getByText('Deposee')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: "Avis d'imposition" })).getByText('Attendue'),
    ).toBeInTheDocument();
    // « En quarantaine » dit a l'avocat ce qu'il doit faire — rien — la ou
    // « infected » ne fait que rapporter un verdict de moteur antiviral.
    expect(
      within(screen.getByRole('listitem', { name: 'Justificatif de domicile' })).getByText(
        'En quarantaine',
      ),
    ).toBeInTheDocument();
  });

  it('ouvre le telechargement d une piece saine derriere son ticket', async () => {
    render_dashboard();

    const identity_row: HTMLElement = await screen.findByRole('listitem', {
      name: "Piece d'identite",
    });
    await userEvent.click(within(identity_row).getByRole('button', { name: 'Telecharger' }));

    // L'URL pre-signee ne vient pas du navigateur : le backend la delivre a
    // l'unite, et il journalise le telechargement au passage.
    expect(open_window).toHaveBeenCalledWith(
      'https://stockage.example/telechargement-signe',
      '_blank',
    );
  });

  it('dit pourquoi une piece ne se telecharge pas, plutot que de la dire introuvable', async () => {
    render_dashboard();

    const quarantined_row: HTMLElement = await screen.findByRole('listitem', {
      name: 'Justificatif de domicile',
    });

    // Le backend repond 409 avec le statut reel : c'est SA piece, lui repondre
    // 404 ne lui cacherait rien et l'empecherait seulement de comprendre.
    await userEvent.click(within(quarantined_row).getByRole('button', { name: 'Telecharger' }));

    expect(await within(quarantined_row).findByRole('alert')).toHaveTextContent(
      'Cette piece est en quarantaine : elle ne peut pas etre telechargee.',
    );
  });

  it('annonce l echeance du lien, et la dit passee quand elle l est', async () => {
    // `shouldAdvanceTime` : sans lui, figer l'horloge figerait aussi les
    // minuteries dont `findBy` a besoin pour attendre la reponse.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    render_dashboard();

    expect(await screen.findByText(/24\/09\/2026/)).toBeInTheDocument();
    expect(screen.getByText('Lien expire')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('previent que regenerer tue l ancien lien, et montre le nouveau une fois', async () => {
    render_dashboard();
    await screen.findByText('Dossier Martin, pieces 2026');

    await userEvent.click(screen.getByRole('button', { name: 'Regenerer le lien' }));

    const delivery_dialog: HTMLElement = await screen.findByRole('alertdialog');

    expect(delivery_dialog).toHaveTextContent('Ce code ne vous sera plus jamais affiche');
    expect(delivery_dialog).toHaveTextContent('nouveau-code-482715');
  });

  it('fait confirmer la revocation avant de couper l acces du client', async () => {
    render_dashboard();
    await screen.findByText('Dossier Martin, pieces 2026');

    await userEvent.click(screen.getByRole('button', { name: 'Revoquer le lien' }));

    // Revoquer sans regenerer laisse le client devant une porte close, sans
    // rien lui dire : la confirmation existe parce que l'action est muette pour
    // celui qui la subit.
    const confirmation: HTMLElement = await screen.findByRole('alertdialog');
    expect(confirmation).toHaveTextContent(
      'Le client ne pourra plus rien deposer, et il n en sera pas averti.',
    );

    expect(revocation_calls(fetch_spy)).toHaveLength(0);
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Revoquer' }));
    expect(revocation_calls(fetch_spy)).toHaveLength(1);
  });

  it('ecrit le journal en francais, sans jamais laisser passer un type brut', async () => {
    fetch_spy.mockImplementation(
      default_api_responses({
        events: ACTIVITY_EVENT_TYPES.map((type: ActivityEventType, index: number) => ({
          id: `evenement-${type}`,
          type,
          actor: { kind: 'system' } as const,
          access_link_id: null,
          deposited_file_id: null,
          occurred_at: `2026-09-11T${String(index).padStart(2, '0')}:00:00.000Z`,
        })),
        has_more: false,
      }),
    );

    render_dashboard();
    const journal: HTMLElement = await screen.findByRole('list', { name: 'Activite' });

    // Un type non traduit s'afficherait tel quel — `deposited_file_scanned_infected`
    // dans une page francaise — et c'est exactement ce que ce balayage interdit.
    for (const entry of within(journal).getAllByRole('listitem')) {
      expect(entry.textContent ?? '').not.toMatch(/[a-z]+_[a-z_]+/);
    }
    expect(within(journal).getAllByRole('listitem')).toHaveLength(ACTIVITY_EVENT_TYPES.length);
  });

  it('signale l activite plus ancienne sans offrir un bouton qui ne mene nulle part', async () => {
    fetch_spy.mockImplementation(
      default_api_responses({
        events: [
          {
            id: 'evenement-1',
            type: 'client_pin_rejected',
            actor: { kind: 'client' },
            access_link_id: 'lien-1',
            deposited_file_id: null,
            occurred_at: '2026-09-11T10:00:00.000Z',
          },
        ],
        has_more: true,
      }),
    );

    render_dashboard();
    const journal: HTMLElement = await screen.findByRole('list', { name: 'Activite' });

    // L'API rend `has_more` mais AUCUN curseur : proposer « Voir plus » serait
    // promettre une page qui n'existe pas.
    expect(screen.getByText(/activite plus ancienne/i)).toBeInTheDocument();
    expect(within(journal).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Voir plus/i })).not.toBeInTheDocument();
  });
});

function revocation_calls(fetch_spy: ReturnType<typeof vi.fn>): unknown[] {
  return fetch_spy.mock.calls.filter(
    (call: unknown[]) =>
      String(call[0]).endsWith('/links/current') &&
      (call[1] as RequestInit | undefined)?.method === 'DELETE',
  );
}

function default_api_responses(
  activity: LawyerActivityPage = QUIET_ACTIVITY,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);

    if (path.endsWith('/activity')) {
      return Promise.resolve(json_response(200, activity));
    }

    if (path.endsWith('/files/fichier-identite/download')) {
      return Promise.resolve(
        json_response(200, {
          download_url: 'https://stockage.example/telechargement-signe',
          expires_at: '2026-09-11T12:00:00.000Z',
        }),
      );
    }

    if (path.endsWith('/files/fichier-domicile/download')) {
      return Promise.resolve(json_response(409, { status: 'infected' }));
    }

    if (path.endsWith('/links/current') && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    if (path.endsWith('/links') && init?.method === 'POST') {
      return Promise.resolve(
        json_response(201, {
          url: 'https://portail.example/deposit/nouveau',
          pin: '482715',
          message: 'Nouveau lien : https://portail.example/deposit/nouveau — nouveau-code-482715',
          expires_at: '2026-10-08T09:00:00.000Z',
        }),
      );
    }

    return Promise.resolve(json_response(200, DETAIL));
  };
}

function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
