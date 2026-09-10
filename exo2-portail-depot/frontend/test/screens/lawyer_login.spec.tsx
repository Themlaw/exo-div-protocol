import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';

import { LawyerLoginScreen } from '../../src/screens/lawyer_login';
import { LAWYER_DEPOSIT_REQUESTS_PATH, LAWYER_LOGIN_PATH } from '../../src/routing/front_routes';
import { render_screen } from '../helpers/render_screen';

const sign_in_with_email = vi.hoisted(() =>
  vi.fn<(credentials: { email: string; password: string }) => Promise<{ error: { message: string } | null }>>(),
);

vi.mock('../../src/auth/lawyer_auth_client', () => ({
  LAWYER_AUTH_BASE_PATH: '/api/v1/auth',
  lawyer_auth_client: { signIn: { email: sign_in_with_email } },
}));

function render_login_screen(entry_path: string = LAWYER_LOGIN_PATH): void {
  render_screen(<LawyerLoginScreen />, {
    route_path: LAWYER_LOGIN_PATH,
    entry_path,
    extra_routes: (
      <Route path={LAWYER_DEPOSIT_REQUESTS_PATH} element={<p>Mes demandes</p>} />
    ),
  });
}

describe('Ecran de connexion avocat', () => {
  beforeEach(() => {
    sign_in_with_email.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    sign_in_with_email.mockReset();
  });

  it('ne tente rien tant qu un champ est vide', async () => {
    render_login_screen();

    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'avocat@cabinet.fr');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    // Un aller-retour reseau pour un formulaire manifestement incomplet ne fait
    // que ralentir la saisie, et il compte dans la limitation de cadence du
    // backend : l'avocat serait ralenti pour ses propres fautes de frappe.
    expect(sign_in_with_email).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Renseignez votre adresse et votre mot de passe.');
  });

  it('ramene l avocat la ou la garde l avait intercepte', async () => {
    render_login_screen();

    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'avocat@cabinet.fr');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'un mot de passe de cinq mots');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(sign_in_with_email).toHaveBeenCalledWith({
      email: 'avocat@cabinet.fr',
      password: 'un mot de passe de cinq mots',
    });
    await waitFor(() => {
      expect(screen.getByText('Mes demandes')).toBeInTheDocument();
    });
  });

  it('refuse sans jamais dire lequel des deux champs est faux', async () => {
    sign_in_with_email.mockResolvedValue({ error: { message: 'Invalid email or password' } });

    render_login_screen();
    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'inconnu@cabinet.fr');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'mauvais mot de passe ici');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    // Une adresse inconnue et un mot de passe faux se repondent de la meme
    // facon, sinon le formulaire devient un enumerateur de comptes. Et le
    // message de la bibliotheque n'est jamais recopie : il est en anglais et il
    // varie selon la cause.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Identifiants invalides.');
    });
    expect(screen.getByLabelText('Mot de passe')).toHaveValue('');
    expect(screen.queryByText(/Invalid email or password/)).not.toBeInTheDocument();
  });

  it('empeche la double soumission pendant l envoi', async () => {
    let release_the_sign_in: (outcome: { error: null }) => void = () => {};
    sign_in_with_email.mockReturnValue(
      new Promise((resolve) => {
        release_the_sign_in = resolve;
      }),
    );

    render_login_screen();
    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'avocat@cabinet.fr');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'un mot de passe de cinq mots');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    // Le libelle change AUSSI : un bouton grise sans un mot est indiscernable
    // d'un bouton casse.
    const submit_button: HTMLElement = screen.getByRole('button', { name: 'Connexion en cours' });
    expect(submit_button).toBeDisabled();

    await userEvent.click(submit_button);
    expect(sign_in_with_email).toHaveBeenCalledTimes(1);

    release_the_sign_in({ error: null });
  });
});
