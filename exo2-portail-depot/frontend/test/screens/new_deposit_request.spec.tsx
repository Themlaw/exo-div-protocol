import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewDepositRequestScreen } from '../../src/screens/new_deposit_request';
import { LAWYER_NEW_DEPOSIT_REQUEST_PATH } from '../../src/routing/front_routes';
import { render_screen } from '../helpers/render_screen';

const DELIVERY = {
  url: 'https://portail.example/deposit/aB3cD4',
  pin: '482715',
  message: 'Bonjour, voici le lien pour deposer vos pieces : https://portail.example/deposit/aB3cD4 — code 482715',
  expires_at: '2026-09-24T09:00:00.000Z',
};

function render_new_deposit_request(): void {
  render_screen(<NewDepositRequestScreen />, { route_path: LAWYER_NEW_DEPOSIT_REQUEST_PATH });
}

async function fill_first_document(label: string): Promise<void> {
  const first_document: HTMLElement = screen.getByRole('group', { name: 'Document 1' });

  await userEvent.type(within(first_document).getByLabelText('Intitule'), label);
  await userEvent.click(within(first_document).getByRole('checkbox', { name: 'PDF' }));
}

describe('Ecran de creation d une demande', () => {
  const fetch_spy = vi.fn<typeof fetch>();
  const write_to_clipboard = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch_spy);
    vi.stubGlobal('navigator', { clipboard: { writeText: write_to_clipboard } });
    write_to_clipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fetch_spy.mockReset();
    write_to_clipboard.mockReset();
    vi.unstubAllGlobals();
  });

  it('part avec un document, et interdit de retirer le dernier', async () => {
    render_new_deposit_request();

    // Une demande sans document attendu est refusee par le backend : la rendre
    // impossible a construire evite un aller-retour pour rien.
    expect(screen.getAllByRole('group', { name: /^Document / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retirer le document 1' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un document' }));

    expect(screen.getAllByRole('group', { name: /^Document / })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retirer le document 1' })).toBeEnabled();
  });

  it('renumerote les documents quand on en retire un du milieu', async () => {
    render_new_deposit_request();

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un document' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un document' }));

    const second_document: HTMLElement = screen.getByRole('group', { name: 'Document 2' });
    await userEvent.type(within(second_document).getByLabelText('Intitule'), 'Le deuxieme');

    await userEvent.click(screen.getByRole('button', { name: 'Retirer le document 1' }));

    // La position n'est pas qu'un numero d'affichage : c'est le champ que le
    // backend enregistre et qui ordonne le tableau du client.
    const documents: HTMLElement[] = screen.getAllByRole('group', { name: /^Document / });
    expect(documents.map((group: HTMLElement) => group.getAttribute('aria-label'))).toEqual([
      'Document 1',
      'Document 2',
    ]);
    expect(within(documents[0] as HTMLElement).getByLabelText('Intitule')).toHaveValue(
      'Le deuxieme',
    );
  });

  it('envoie exactement la forme que le backend sait lire', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const [, request_init] = fetch_spy.mock.calls[0] as [string, RequestInit];

    expect(JSON.parse(String(request_init.body))).toEqual({
      title: 'Dossier Martin',
      expected_documents: [
        {
          label: "Piece d'identite",
          position: 1,
          allowed_mime_types: ['application/pdf'],
          // La saisie est en Mo parce que c'est l'unite de l'avocat ; l'API
          // veut des octets, et la conversion se fait ici.
          max_size_bytes: 20 * 1024 * 1024,
        },
      ],
    });
  });

  it('rend toutes les violations du backend d un seul coup', async () => {
    fetch_spy.mockResolvedValue(
      json_response(400, {
        violations: ['title_missing', 'expected_document_label_missing'],
      }),
    );

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'x');
    await fill_first_document('y');
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const refusal: HTMLElement = await screen.findByRole('alert');

    expect(refusal).toHaveTextContent('Le titre est obligatoire.');
    expect(refusal).toHaveTextContent("Chaque document doit porter un intitule.");
  });

  it('montre le couple lien et code une seule fois, pret a envoyer', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const delivery_dialog: HTMLElement = await screen.findByRole('alertdialog');

    // L'avertissement est EN HAUT : lu apres coup, il ne sert plus a rien.
    expect(delivery_dialog).toHaveTextContent('Ce code ne vous sera plus jamais affiche');
    expect(delivery_dialog).toHaveTextContent(DELIVERY.message);

    await userEvent.click(
      within(delivery_dialog).getByRole('button', { name: 'Copier le message' }),
    );

    expect(write_to_clipboard).toHaveBeenCalledWith(DELIVERY.message);
  });

  it('previent avant de fermer si le message n a pas ete copie', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const delivery_dialog: HTMLElement = await screen.findByRole('alertdialog');
    await userEvent.click(within(delivery_dialog).getByRole('button', { name: 'Continuer' }));

    // Le PIN est hache cote serveur : ferme sans etre copie, il est perdu pour
    // de bon et la demande nait sans acces utilisable.
    expect(delivery_dialog).toHaveTextContent(
      'Vous n avez pas copie le message. Fermer maintenant le perdra definitivement.',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
