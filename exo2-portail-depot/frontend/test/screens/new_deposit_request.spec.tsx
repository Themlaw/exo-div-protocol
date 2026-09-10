import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewDepositRequestScreen } from '../../src/screens/new_deposit_request';
import { LAWYER_NEW_DEPOSIT_REQUEST_PATH } from '../../src/routing/front_routes';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS,
} from '../../src/api/contracts';
import { render_screen } from '../helpers/render_screen';

const LINK_LIFETIME_LABEL = 'Duree de validite du lien (jours)';
const PIN_LENGTH_LABEL = 'Longueur du code d acces (chiffres)';
const MAX_PIN_ATTEMPTS_LABEL = 'Essais de code autorises';

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
      // L'avocat qui ne touche a rien doit obtenir EXACTEMENT le comportement
      // d'avant : la politique par defaut est envoyee telle quelle, et non
      // omise, pour que l'ecran dise ce qu'il a fait.
      security_policy: DEFAULT_SECURITY_POLICY,
    });
  });

  it('affiche la politique de securite reglee sur les valeurs par defaut du domaine', () => {
    render_new_deposit_request();

    expect(screen.getByLabelText(LINK_LIFETIME_LABEL)).toHaveValue(
      DEFAULT_SECURITY_POLICY.link_lifetime_days,
    );
    expect(screen.getByLabelText(PIN_LENGTH_LABEL)).toHaveValue(
      DEFAULT_SECURITY_POLICY.pin_length,
    );
    expect(screen.getByLabelText(MAX_PIN_ATTEMPTS_LABEL)).toHaveValue(
      DEFAULT_SECURITY_POLICY.max_pin_attempts,
    );
  });

  // Les bornes sont posees sur le champ lui-meme : le serveur revalide de toute
  // facon, mais un aller-retour refuse pour un 30 tape a la place d'un 3 est un
  // aller-retour qu'on pouvait eviter.
  it('borne chaque champ de la politique aux valeurs que le backend accepte', () => {
    render_new_deposit_request();

    const bounded_fields: readonly [string, { readonly min: number; readonly max: number }][] = [
      [LINK_LIFETIME_LABEL, SECURITY_POLICY_BOUNDS.link_lifetime_days],
      [PIN_LENGTH_LABEL, SECURITY_POLICY_BOUNDS.pin_length],
      [MAX_PIN_ATTEMPTS_LABEL, SECURITY_POLICY_BOUNDS.max_pin_attempts],
    ];

    for (const [label, bounds] of bounded_fields) {
      const field: HTMLElement = screen.getByLabelText(label);

      expect(field).toHaveAttribute('min', String(bounds.min));
      expect(field).toHaveAttribute('max', String(bounds.max));
    }
  });

  it('envoie la politique de securite reglee par l avocat', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");

    await userEvent.clear(screen.getByLabelText(LINK_LIFETIME_LABEL));
    await userEvent.type(screen.getByLabelText(LINK_LIFETIME_LABEL), '3');
    await userEvent.clear(screen.getByLabelText(PIN_LENGTH_LABEL));
    await userEvent.type(screen.getByLabelText(PIN_LENGTH_LABEL), '8');
    await userEvent.clear(screen.getByLabelText(MAX_PIN_ATTEMPTS_LABEL));
    await userEvent.type(screen.getByLabelText(MAX_PIN_ATTEMPTS_LABEL), '5');

    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const [, request_init] = fetch_spy.mock.calls[0] as [string, RequestInit];

    expect(
      (JSON.parse(String(request_init.body)) as { security_policy: unknown }).security_policy,
    ).toEqual({ link_lifetime_days: 3, pin_length: 8, max_pin_attempts: 5 });
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

  // Le retour visuel n'est pas un confort : sans lui, l'avocat ne sait pas si
  // le presse-papier tient le seul exemplaire d'un code qu'il ne reverra
  // jamais, et il reclique — ou pire, il ferme.
  it('confirme la copie sur le bouton, et le dit assez longtemps pour etre lu', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const delivery_dialog: HTMLElement = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(delivery_dialog).getByRole('button', { name: 'Copier le message' }),
    );

    expect(
      await within(delivery_dialog).findByRole('button', { name: 'Message copie' }),
    ).toBeInTheDocument();
  });

  // Ne jamais annoncer une copie qui n'a pas eu lieu : le message affiche est
  // le seul recours qui reste a l'avocat, et lui faire croire qu'il l'a en
  // memoire lui ferait fermer la popup pour de bon.
  it('ne pretend pas avoir copie quand le presse-papier refuse', async () => {
    fetch_spy.mockResolvedValue(json_response(201, { id: 'dossier-martin', access_link: DELIVERY }));
    write_to_clipboard.mockRejectedValue(new Error('permission refusee'));

    render_new_deposit_request();
    await userEvent.type(screen.getByLabelText('Titre de la demande'), 'Dossier Martin');
    await fill_first_document("Piece d'identite");
    await userEvent.click(screen.getByRole('button', { name: 'Creer la demande' }));

    const delivery_dialog: HTMLElement = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(delivery_dialog).getByRole('button', { name: 'Copier le message' }),
    );

    expect(await within(delivery_dialog).findByText(/copie a echoue/i)).toBeInTheDocument();
    expect(
      within(delivery_dialog).queryByRole('button', { name: 'Message copie' }),
    ).not.toBeInTheDocument();

    // La copie ayant echoue, la popup doit toujours prevenir avant de fermer.
    await userEvent.click(within(delivery_dialog).getByRole('button', { name: 'Continuer' }));
    expect(delivery_dialog).toHaveTextContent(
      'Vous n avez pas copie le message. Fermer maintenant le perdra definitivement.',
    );
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
