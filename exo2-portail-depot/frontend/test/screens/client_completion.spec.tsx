import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClientDepositScreen } from '../../src/screens/client_deposit';
import { CLIENT_DEPOSIT_PATH } from '../../src/routing/front_routes';
import type { ClientDepositBoardView } from '../../src/api/contracts';
import { render_screen } from '../helpers/render_screen';
import {
  DEPOSIT_BOARD,
  DEPOSIT_ENTRY_PATH,
  HOUSING_DOCUMENT,
  IDENTITY_DOCUMENT,
  json_response,
  stub_client_deposit_api,
} from '../helpers/client_deposit_api';

const COMPLETE_BOARD: ClientDepositBoardView = {
  ...DEPOSIT_BOARD,
  expected_documents: [
    {
      ...IDENTITY_DOCUMENT,
      deposited_file: { id: 'fichier-identite', display_filename: 'cni.pdf', status: 'clean' },
    },
    HOUSING_DOCUMENT,
  ],
};

const TRANSMITTED_BOARD: ClientDepositBoardView = {
  ...COMPLETE_BOARD,
  deposit_request_status: 'processing',
};

function render_client_deposit(): void {
  render_screen(<ClientDepositScreen />, {
    route_path: CLIENT_DEPOSIT_PATH,
    entry_path: DEPOSIT_ENTRY_PATH,
  });
}

function removal_calls(fetch_spy: ReturnType<typeof vi.fn>): unknown[] {
  return fetch_spy.mock.calls.filter(
    (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
  );
}

describe('Retrait et fin du depot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fait confirmer un retrait avant de supprimer quoi que ce soit', async () => {
    const fetch_spy = stub_client_deposit_api();

    render_client_deposit();
    const housing_slot: HTMLElement = await screen.findByRole('listitem', {
      name: 'Justificatif de domicile',
    });
    await userEvent.click(within(housing_slot).getByRole('button', { name: 'Retirer' }));

    // La suppression est definitive cote stockage : la confirmation nomme le
    // fichier plutot que de demander « etes-vous sur ».
    const confirmation: HTMLElement = await screen.findByRole('alertdialog');
    expect(confirmation).toHaveTextContent('edf.pdf');
    expect(removal_calls(fetch_spy)).toHaveLength(0);

    await userEvent.click(within(confirmation).getByRole('button', { name: 'Retirer' }));

    await waitFor(() => {
      expect(removal_calls(fetch_spy)).toHaveLength(1);
    });
  });

  it('rouvre l emplacement libere a un nouvel envoi', async () => {
    stub_client_deposit_api();

    render_client_deposit();
    const identity_slot: HTMLElement = await screen.findByRole('listitem', {
      name: "Piece d'identite",
    });

    // Un emplacement vide porte un champ de fichier, un emplacement occupe porte
    // un bouton de retrait : c'est la seule difference, et elle est visible.
    expect(
      within(identity_slot).getByLabelText("Choisir un fichier pour Piece d'identite"),
    ).toBeInTheDocument();
    expect(within(identity_slot).queryByRole('button', { name: 'Retirer' })).not.toBeInTheDocument();
  });

  it('nomme ce qui manque avant de laisser terminer quand meme', async () => {
    stub_client_deposit_api();

    render_client_deposit();
    await screen.findByText('Dossier Martin, pieces 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Terminer le depot' }));

    // Le client a parfois une bonne raison — un document qu'il n'aura jamais.
    // On le previent, on ne l'empeche pas : le backend accepte, et l'avocat
    // verra la demande arriver incomplete avec son journal.
    const confirmation: HTMLElement = await screen.findByRole('alertdialog');
    expect(confirmation).toHaveTextContent('1 emplacement est vide.');
    expect(within(confirmation).getByRole('button', { name: 'Terminer' })).toBeEnabled();
  });

  it('gele l envoi et le retrait une fois le depot transmis', async () => {
    stub_client_deposit_api({ board: TRANSMITTED_BOARD });

    render_client_deposit();
    await screen.findByText('Dossier Martin, pieces 2026');

    expect(screen.getByRole('status')).toHaveTextContent(
      'Votre depot a ete transmis. Les pieces ne peuvent plus etre modifiees.',
    );
    // A partir de la, la demande appartient au dossier de l'avocat : la
    // modifier changerait sous ses yeux ce qu'il est en train d'examiner.
    expect(screen.queryByRole('button', { name: 'Terminer le depot' })).not.toBeInTheDocument();
    for (const removal_button of screen.queryAllByRole('button', { name: 'Retirer' })) {
      expect(removal_button).toBeDisabled();
    }
  });

  it('explique un depot qui ne peut plus etre termine, sans planter', async () => {
    stub_client_deposit_api({
      board: COMPLETE_BOARD,
      completion: json_response(409, { message: 'Ce depot ne peut plus etre termine' }),
    });

    render_client_deposit();
    await screen.findByText('Dossier Martin, pieces 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Terminer le depot' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Terminer' }),
    );

    // Terminer deux fois, ou terminer sur un lien bloque, n'est pas une panne :
    // c'est une interface qui a propose une action qu'elle n'aurait pas du.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ce depot ne peut plus etre termine. Rechargez la page pour voir son etat.',
    );
  });
});
