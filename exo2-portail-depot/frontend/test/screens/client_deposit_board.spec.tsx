import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { ClientDepositScreen } from '../../src/screens/client_deposit';
import { CLIENT_DEPOSIT_PATH } from '../../src/routing/front_routes';
import { render_screen } from '../helpers/render_screen';
import {
  DEPOSIT_ENTRY_PATH,
  json_response,
  stub_client_deposit_api,
} from '../helpers/client_deposit_api';

function render_client_deposit(): void {
  render_screen(<ClientDepositScreen />, {
    route_path: CLIENT_DEPOSIT_PATH,
    entry_path: DEPOSIT_ENTRY_PATH,
  });
}

describe('Tableau de depot du client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('nomme le dossier ouvert et ses emplacements', async () => {
    stub_client_deposit_api();

    render_client_deposit();

    // Le titre apparait ICI et pas avant le code : avant, il serait une fuite ;
    // apres, il est ce qui permet de savoir quel dossier on ouvre quand on en a
    // recu plusieurs du meme cabinet.
    expect(await screen.findByText('Dossier Martin, pieces 2026')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('rappelle a chaque emplacement ce qu il accepte', async () => {
    stub_client_deposit_api();

    render_client_deposit();
    const identity_slot: HTMLElement = await screen.findByRole('listitem', {
      name: "Piece d'identite",
    });

    // Annoncer les contraintes AVANT l'envoi evite un aller-retour de vingt
    // megaoctets pour apprendre qu'on n'en avait droit qu'a cinq.
    expect(identity_slot).toHaveTextContent('PDF');
    expect(identity_slot).toHaveTextContent('5 Mo');
  });

  it('montre le fichier deja depose et son etat', async () => {
    stub_client_deposit_api();

    render_client_deposit();
    const housing_slot: HTMLElement = await screen.findByRole('listitem', {
      name: 'Justificatif de domicile',
    });

    expect(within(housing_slot).getByText('edf.pdf')).toBeInTheDocument();
    expect(within(housing_slot).getByText('Deposee')).toBeInTheDocument();
  });

  it('annonce jusqu a quand la session reste ouverte', async () => {
    stub_client_deposit_api();

    render_client_deposit();

    // Une session de trente minutes qui se ferme sans prevenir se lit comme une
    // panne, et le client rappelle son avocat.
    expect(await screen.findByText(/Votre acces reste ouvert jusqu a/)).toBeInTheDocument();
  });

  it('redemande le code quand la session s est refermee', async () => {
    const fetch_spy = stub_client_deposit_api();
    fetch_spy.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith('/documents')
          ? json_response(401, { message: 'Non authentifie' })
          : json_response(200, { state: 'active', pin_length: 6 }),
      ),
    );

    render_client_deposit();

    // La session dure trente minutes : un depot commence avant le dejeuner se
    // termine derriere le code, pas derriere un ecran d'erreur.
    expect(await screen.findAllByRole('textbox', { name: /^Chiffre / })).toHaveLength(6);
  });
});
