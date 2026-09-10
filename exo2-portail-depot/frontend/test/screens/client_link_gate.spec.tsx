import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClientDepositScreen } from '../../src/screens/client_deposit';
import { CLIENT_DEPOSIT_PATH } from '../../src/routing/front_routes';
import type { PublicAccessLinkView } from '../../src/api/contracts';
import { render_screen } from '../helpers/render_screen';

const LINK_TOKEN = 'aB3cD4eF5gH6';
const DEPOSIT_ENTRY_PATH = `/deposit/${LINK_TOKEN}`;

function render_client_deposit(): void {
  render_screen(<ClientDepositScreen />, {
    route_path: CLIENT_DEPOSIT_PATH,
    entry_path: DEPOSIT_ENTRY_PATH,
  });
}

async function type_the_whole_code(code: string): Promise<void> {
  const boxes: HTMLElement[] = screen.getAllByRole('textbox', { name: /^Chiffre / });

  for (const [index, digit] of [...code].entries()) {
    await userEvent.type(boxes[index] as HTMLElement, digit);
  }
}

describe('Porte du lien de depot', () => {
  const fetch_spy = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch_spy);
  });

  afterEach(() => {
    fetch_spy.mockReset();
    vi.unstubAllGlobals();
  });

  it('dessine autant de cases que le code compte de chiffres', async () => {
    answer_with({ state: 'active', pin_length: 6 });

    render_client_deposit();

    // La longueur vient de l'API et de nulle part ailleurs : l'avocat a pu
    // regler un code a douze chiffres pour un dossier sensible.
    expect(await screen.findAllByRole('textbox', { name: /^Chiffre / })).toHaveLength(6);
    // Ni titre, ni nom de dossier avant le code : ce serait une fuite pour
    // quiconque possede l'URL sans le code.
    expect(screen.queryByText(/Dossier/)).not.toBeInTheDocument();
  });

  it('dit au client qu il lui faut un nouveau lien quand celui-ci est bloque', async () => {
    answer_with({ state: 'blocked' });

    render_client_deposit();

    expect(
      await screen.findByText(/Ce lien a ete bloque.*demandez-en un nouveau/i),
    ).toBeInTheDocument();
    // Laisser le champ ouvert sur un lien mort ferait consommer des essais qui
    // n'existent plus, et l'API les refuserait tous a l'identique.
    expect(screen.queryByRole('textbox', { name: /^Chiffre / })).not.toBeInTheDocument();
  });

  it('reste muet sur ce qui cloche quand le lien est invalide', async () => {
    answer_with({ state: 'invalid' });

    render_client_deposit();

    // « Ce lien n'existe pas », « il a expire » et « il a ete revoque » se
    // repondent de la meme facon : la difference serait un oracle.
    expect(await screen.findByText(/Ce lien n est pas utilisable/i)).toBeInTheDocument();
    expect(screen.queryByText(/expire|revoque|inconnu/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Chiffre / })).not.toBeInTheDocument();
  });

  it('refuse un mauvais code sans rien en dire, et vide les cases', async () => {
    answer_with({ state: 'active', pin_length: 6 }, { unlock: json_response(401, { state: 'invalid' }) });

    render_client_deposit();
    await screen.findAllByRole('textbox', { name: /^Chiffre / });
    await type_the_whole_code('482715');
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir le depot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ce code ne correspond pas.');
    for (const box of screen.getAllByRole('textbox', { name: /^Chiffre / })) {
      expect(box).toHaveValue('');
    }
  });

  it('fait patienter plutot que redemander un lien quand l adresse est bridee', async () => {
    answer_with(
      { state: 'active', pin_length: 6 },
      {
        unlock: new Response(JSON.stringify({ state: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '900' },
        }),
      },
    );

    render_client_deposit();
    await screen.findAllByRole('textbox', { name: /^Chiffre / });
    await type_the_whole_code('482715');
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir le depot' }));

    // Le seul refus qui s'explique : il parle de l'adresse, pas du lien. Sans
    // cette phrase, un destinataire legitime redemanderait un lien a son avocat.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Trop d essais depuis votre connexion. Reessayez dans 15 minutes.',
    );
    expect(screen.getByRole('button', { name: 'Ouvrir le depot' })).toBeDisabled();
  });

  function answer_with(
    link_state: PublicAccessLinkView,
    responses: { readonly unlock?: Response } = {},
  ): void {
    fetch_spy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);

      if (path.endsWith('/unlock') && init?.method === 'POST') {
        return Promise.resolve(
          responses.unlock ?? json_response(200, { expires_at: '2026-09-11T10:30:00.000Z' }),
        );
      }

      if (path.endsWith('/documents')) {
        return Promise.resolve(json_response(401, { message: 'Non authentifie' }));
      }

      return Promise.resolve(json_response(200, link_state));
    });
  }
});

function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
