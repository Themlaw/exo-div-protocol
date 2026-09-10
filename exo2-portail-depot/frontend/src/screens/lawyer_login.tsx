import { useState, type FormEvent, type ReactElement } from 'react';
import { Heading, Stack, Text } from '@chakra-ui/react';
import { useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom';

import { lawyer_auth_client } from '../auth/lawyer_auth_client';
import { LAWYER_DEPOSIT_REQUESTS_PATH } from '../routing/front_routes';
import { PrimaryButton } from '../ui/div_button';
import { TextField } from '../ui/text_field';

const INCOMPLETE_FORM_MESSAGE = 'Renseignez votre adresse et votre mot de passe.';
// Le MEME message quelle que soit la cause. Distinguer « compte inconnu » de
// « mot de passe faux » ferait du formulaire un enumerateur de comptes, et le
// message de la bibliotheque est en anglais et varie selon la cause.
const REJECTED_CREDENTIALS_MESSAGE = 'Identifiants invalides.';

interface IntendedDestination {
  readonly intended_path?: string;
}

export function LawyerLoginScreen(): ReactElement {
  const navigate: NavigateFunction = useNavigate();
  const location: Location = useLocation();
  const [email, set_email] = useState<string>('');
  const [password, set_password] = useState<string>('');
  const [failure_message, set_failure_message] = useState<string | null>(null);
  const [is_signing_in, set_is_signing_in] = useState<boolean>(false);

  async function submit_credentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (email.trim() === '' || password === '') {
      set_failure_message(INCOMPLETE_FORM_MESSAGE);

      return;
    }

    set_failure_message(null);
    set_is_signing_in(true);

    const outcome = await lawyer_auth_client.signIn.email({ email: email.trim(), password });

    set_is_signing_in(false);

    if (outcome.error !== null && outcome.error !== undefined) {
      // Le mot de passe est efface, jamais l'adresse : on ne refait pas saisir
      // ce qui n'est pas secret.
      set_password('');
      set_failure_message(REJECTED_CREDENTIALS_MESSAGE);

      return;
    }

    navigate(read_intended_path(location.state), { replace: true });
  }

  return (
    <Stack gap="6" maxWidth="26rem" marginX="auto" paddingY="16" paddingX="4">
      <Heading size="lg">Connexion</Heading>
      <Text>Le portail de depot est reserve aux avocats du cabinet.</Text>

      <form onSubmit={(event) => void submit_credentials(event)} noValidate>
        <Stack gap="4">
          <TextField
            label="Adresse e-mail"
            type="email"
            value={email}
            on_change={set_email}
            is_disabled={is_signing_in}
          />
          <TextField
            label="Mot de passe"
            type="password"
            value={password}
            on_change={set_password}
            is_disabled={is_signing_in}
          />

          {failure_message === null ? null : (
            <Text role="alert" color="danger.fg">
              {failure_message}
            </Text>
          )}

          <PrimaryButton type="submit" disabled={is_signing_in}>
            {is_signing_in ? 'Connexion en cours' : 'Se connecter'}
          </PrimaryButton>
        </Stack>
      </form>
    </Stack>
  );
}

// La garde a memorise la destination avant de rediriger : sans cela, l'avocat
// qui ouvre un lien vers un dossier precis atterrit sur la liste et doit le
// retrouver a la main.
function read_intended_path(navigation_state: unknown): string {
  if (typeof navigation_state !== 'object' || navigation_state === null) {
    return LAWYER_DEPOSIT_REQUESTS_PATH;
  }

  const { intended_path } = navigation_state as IntendedDestination;

  return typeof intended_path === 'string' && intended_path.startsWith('/')
    ? intended_path
    : LAWYER_DEPOSIT_REQUESTS_PATH;
}
