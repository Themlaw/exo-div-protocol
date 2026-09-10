import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';

import { LawyerLoginScreen } from '../../src/screens/lawyer_login';
import { LAWYER_DEPOSIT_REQUESTS_PATH, LAWYER_LOGIN_PATH } from '../../src/routing/front_routes';
import { RequireLawyerSession } from '../../src/routing/require_lawyer_session';
import { render_screen } from '../helpers/render_screen';

// Ce faux reproduit le comportement OBSERVE de better-auth 1.7.3, et c'est tout
// l'interet du test. Le magasin de session est un atome nanostores : il se
// demonte des que plus aucun composant ne le lit, c'est-a-dire des que la garde
// a renvoye l'avocat vers ce formulaire. Demonte, il conserve sa derniere valeur
// — « anonyme » — et n'ecoute plus le signal emis par la connexion. La session
// acceptee n'est donc visible qu'apres une relecture explicite : c'est ce que
// `visible_session`, distinct de `accepted_email`, represente ici.
const session_store = vi.hoisted(() => ({
  accepted_email: null as string | null,
  visible_session: null as { user: { email: string } } | null,
  hold_the_reload: null as Promise<void> | null,
}));

const sign_in_with_email = vi.hoisted(() =>
  vi.fn<
    (credentials: { email: string; password: string }) => Promise<{ error: { message: string } | null }>
  >(),
);

const reload_session = vi.hoisted(() =>
  vi.fn(async (): Promise<void> => {
    if (session_store.hold_the_reload !== null) {
      await session_store.hold_the_reload;
    }

    session_store.visible_session =
      session_store.accepted_email === null
        ? null
        : { user: { email: session_store.accepted_email } };
  }),
);

vi.mock('../../src/auth/lawyer_auth_client', () => ({
  LAWYER_AUTH_BASE_PATH: '/api/v1/auth',
  lawyer_auth_client: {
    signIn: { email: sign_in_with_email },
    useSession: () => ({
      data: session_store.visible_session,
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: reload_session,
    }),
  },
}));

interface RenderLoginOptions {
  readonly entry_path?: string;
  readonly guard_the_destination?: boolean;
}

function render_login_screen(options: RenderLoginOptions = {}): void {
  const destination = <p>Mes demandes</p>;

  render_screen(<LawyerLoginScreen />, {
    route_path: LAWYER_LOGIN_PATH,
    entry_path: options.entry_path ?? LAWYER_LOGIN_PATH,
    extra_routes: (
      <Route
        path={LAWYER_DEPOSIT_REQUESTS_PATH}
        element={
          options.guard_the_destination === true ? (
            <RequireLawyerSession>{destination}</RequireLawyerSession>
          ) : (
            destination
          )
        }
      />
    ),
  });
}

async function fill_in_and_submit(email: string, password: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Adresse e-mail'), email);
  await userEvent.type(screen.getByLabelText('Mot de passe'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
}

describe('Ecran de connexion avocat', () => {
  beforeEach(() => {
    sign_in_with_email.mockImplementation(async ({ email }) => {
      session_store.accepted_email = email;

      return { error: null };
    });
  });

  afterEach(() => {
    sign_in_with_email.mockReset();
    reload_session.mockClear();
    session_store.accepted_email = null;
    session_store.visible_session = null;
    session_store.hold_the_reload = null;
  });

  it('ne tente rien tant qu un champ est vide', async () => {
    render_login_screen();

    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'avocat@cabinet.fr');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    // Un aller-retour reseau pour un formulaire manifestement incomplet ne fait
    // que ralentir la saisie, et il compte dans la limitation de cadence du
    // backend : l'avocat serait ralenti pour ses propres fautes de frappe.
    expect(sign_in_with_email).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Renseignez votre adresse et votre mot de passe.',
    );
  });

  it('ramene l avocat la ou la garde l avait intercepte', async () => {
    render_login_screen();

    await fill_in_and_submit('avocat@cabinet.fr', 'un mot de passe de cinq mots');

    expect(sign_in_with_email).toHaveBeenCalledWith({
      email: 'avocat@cabinet.fr',
      password: 'un mot de passe de cinq mots',
    });
    await waitFor(() => {
      expect(screen.getByText('Mes demandes')).toBeInTheDocument();
    });
  });

  it('ouvre la route gardee des la PREMIERE connexion', async () => {
    // La regression qui a coute deux connexions a l'avocat : le formulaire
    // naviguait des que la connexion etait acceptee, sans avoir relu la session.
    // La garde, qui se remonte alors, lisait la derniere valeur laissee par le
    // magasin demonte — « anonyme » — et renvoyait au formulaire. La seconde
    // tentative marchait parce que la relecture de la premiere avait fini
    // entre-temps.
    render_login_screen({ guard_the_destination: true });

    await fill_in_and_submit('avocat@cabinet.fr', 'un mot de passe de cinq mots');

    await waitFor(() => {
      expect(screen.getByText('Mes demandes')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Mot de passe')).not.toBeInTheDocument();
    expect(sign_in_with_email).toHaveBeenCalledTimes(1);
  });

  it('refuse sans jamais dire lequel des deux champs est faux', async () => {
    sign_in_with_email.mockResolvedValue({ error: { message: 'Invalid email or password' } });

    render_login_screen();
    await fill_in_and_submit('inconnu@cabinet.fr', 'mauvais mot de passe ici');

    // Une adresse inconnue et un mot de passe faux se repondent de la meme
    // facon, sinon le formulaire devient un enumerateur de comptes. Et le
    // message de la bibliotheque n'est jamais recopie : il est en anglais et il
    // varie selon la cause.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Identifiants invalides.');
    });
    expect(screen.getByLabelText('Mot de passe')).toHaveValue('');
    expect(screen.queryByText(/Invalid email or password/)).not.toBeInTheDocument();
    // Relire la session apres un refus ne peut rien apprendre et ferait payer un
    // aller-retour de plus a chaque faute de frappe.
    expect(reload_session).not.toHaveBeenCalled();
  });

  it('empeche la double soumission pendant l envoi', async () => {
    let release_the_sign_in: (outcome: { error: null }) => void = () => {};
    sign_in_with_email.mockReturnValue(
      new Promise((resolve) => {
        release_the_sign_in = resolve;
      }),
    );

    render_login_screen();
    await fill_in_and_submit('avocat@cabinet.fr', 'un mot de passe de cinq mots');

    // Le libelle change AUSSI : un bouton grise sans un mot est indiscernable
    // d'un bouton casse.
    const submit_button: HTMLElement = screen.getByRole('button', { name: 'Connexion en cours' });
    expect(submit_button).toBeDisabled();

    await userEvent.click(submit_button);
    expect(sign_in_with_email).toHaveBeenCalledTimes(1);

    release_the_sign_in({ error: null });
  });

  it('attend d avoir lu la session avant de rendre la main', async () => {
    // La lecture de la session est un second aller-retour, apres celui de la
    // connexion. Rendre la main entre les deux affiche un formulaire au repos
    // alors que rien n'est fini : l'avocat croit que son clic n'a pas pris et
    // reclique.
    let release_the_reload: () => void = () => {};
    session_store.hold_the_reload = new Promise<void>((resolve) => {
      release_the_reload = resolve;
    });

    render_login_screen({ guard_the_destination: true });
    await fill_in_and_submit('avocat@cabinet.fr', 'un mot de passe de cinq mots');

    const submit_button: HTMLElement = screen.getByRole('button', { name: 'Connexion en cours' });
    expect(submit_button).toBeDisabled();
    expect(screen.queryByText('Mes demandes')).not.toBeInTheDocument();

    release_the_reload();

    await waitFor(() => {
      expect(screen.getByText('Mes demandes')).toBeInTheDocument();
    });
  });
});
