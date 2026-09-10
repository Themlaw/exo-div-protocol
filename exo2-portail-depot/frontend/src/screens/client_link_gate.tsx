import { useRef, useState, type ReactElement } from 'react';
import { Flex, Heading, Stack, Text, chakra, useRecipe } from '@chakra-ui/react';

import { ApiFailure } from '../api/api_client';
import type { PublicAccessLinkView } from '../api/contracts';
import { use_public_link_state, use_unlock_deposit_link } from '../api/client_queries';
import { PrimaryButton } from '../ui/div_button';
import { ResourceStates } from '../ui/resource_states';

const BLOCKED_LINK_MESSAGE =
  'Ce lien a ete bloque apres trop de codes errones : demandez-en un nouveau a votre avocat.';
// Un lien inconnu, expire ou revoque se disent de la MEME facon. Nommer la
// cause ferait de la page un oracle : l'API elle-meme repond a l'identique.
const UNUSABLE_LINK_MESSAGE =
  'Ce lien n est pas utilisable. Demandez-en un nouveau a votre avocat.';
const REJECTED_PIN_MESSAGE = 'Ce code ne correspond pas.';

export interface ClientLinkGateProps {
  readonly token: string;
}

export function ClientLinkGate({ token }: ClientLinkGateProps): ReactElement {
  const link_state = use_public_link_state(token);

  return (
    <ResourceStates
      state={link_state.isPending ? 'loading' : link_state.isError ? 'error' : 'ready'}
      loading_label="Ouverture du lien"
      error_message="Impossible de joindre le portail. Verifiez votre connexion."
      on_retry={(): void => {
        void link_state.refetch();
      }}
      empty_message=""
      empty_call_to_action={null}
    >
      {link_state.data === undefined ? null : (
        <LinkStateView token={token} link={link_state.data} />
      )}
    </ResourceStates>
  );
}

function LinkStateView({
  token,
  link,
}: {
  readonly token: string;
  readonly link: PublicAccessLinkView;
}): ReactElement {
  if (link.state === 'blocked') {
    return <DeadLinkNotice message={BLOCKED_LINK_MESSAGE} />;
  }

  if (link.state === 'invalid' || link.pin_length === undefined) {
    return <DeadLinkNotice message={UNUSABLE_LINK_MESSAGE} />;
  }

  return <PinForm token={token} pin_length={link.pin_length} />;
}

function DeadLinkNotice({ message }: { readonly message: string }): ReactElement {
  return (
    <Stack gap="4" maxWidth="30rem" marginX="auto" paddingY="16" paddingX="4">
      <Heading size="lg">Depot de pieces</Heading>
      <Text role="alert">{message}</Text>
    </Stack>
  );
}

function PinForm({
  token,
  pin_length,
}: {
  readonly token: string;
  readonly pin_length: number;
}): ReactElement {
  const [digits, set_digits] = useState<readonly string[]>(() => Array<string>(pin_length).fill(''));
  const box_refs = useRef<(HTMLInputElement | null)[]>([]);
  const unlock = use_unlock_deposit_link(token);
  const recipe = useRecipe({ key: 'textField' });

  function write_digit(index: number, raw: string): void {
    // Un collage du code entier atterrit dans une seule case : l'eclater ici
    // evite d'obliger le client a retaper ce qu'il vient de coller.
    const typed_digits: string[] = [...raw].filter((character: string) => /\d/.test(character));

    if (typed_digits.length === 0) {
      set_digits((current) => current.map((digit, position) => (position === index ? '' : digit)));

      return;
    }

    set_digits((current) =>
      current.map((digit, position) =>
        position >= index && position - index < typed_digits.length
          ? (typed_digits[position - index] as string)
          : digit,
      ),
    );

    const next_index: number = Math.min(index + typed_digits.length, pin_length - 1);
    box_refs.current[next_index]?.focus();
  }

  function submit_pin(): void {
    const submitted_pin: string = digits.join('');

    // Vidées ICI, a l'envoi, et non a l'arrivee de la reponse. Laisser le code
    // en place ferait renvoyer le meme, et chaque essai compte pour le blocage ;
    // mais le vider a la reponse l'efface SOUS LES DOIGTS du client qui a deja
    // recommence a taper — le temps d'aller-retour n'est pas le notre, il est
    // celui de sa connexion. Le bouton resterait alors desactive sur des cases
    // qu'il vient de remplir, sans que rien ne l'explique.
    set_digits(Array<string>(pin_length).fill(''));
    box_refs.current[0]?.focus();

    unlock.mutate(submitted_pin);
  }

  const is_rate_limited: boolean =
    unlock.error instanceof ApiFailure && unlock.error.kind === 'rate_limited';

  return (
    <Stack gap="6" maxWidth="30rem" marginX="auto" paddingY="16" paddingX="4">
      <Heading size="lg">Depot de pieces</Heading>
      <Text>Saisissez le code recu avec ce lien.</Text>

      {/* Les cases se PARTAGENT la largeur au lieu de l'imposer. A 3rem fixes,
          six cases demandaient 360 px et la sixieme tombait seule sur une
          deuxieme ligne des que l'ecran passait sous 360 : un code lu « cinq
          chiffres puis un » invite a la faute de saisie. La borne basse garde
          une cible tactile, et un code plus long — la politique en autorise
          jusqu'a douze — se replie alors en lignes egales. */}
      <Flex gap="2" wrap="wrap">
        {digits.map((digit: string, index: number) => (
          <chakra.input
            key={index}
            ref={(element: HTMLInputElement | null): void => {
              box_refs.current[index] = element;
            }}
            css={recipe()}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={`Chiffre ${String(index + 1)}`}
            flex="1 1 0"
            minWidth="2.25rem"
            maxWidth="3rem"
            textAlign="center"
            value={digit}
            disabled={is_rate_limited}
            onChange={(event) => write_digit(index, event.target.value)}
          />
        ))}
      </Flex>

      <UnlockRefusal failure={unlock.error} />

      <PrimaryButton
        onClick={submit_pin}
        disabled={unlock.isPending || is_rate_limited || digits.some((digit) => digit === '')}
      >
        Ouvrir le depot
      </PrimaryButton>
    </Stack>
  );
}

function UnlockRefusal({ failure }: { readonly failure: ApiFailure | null }): ReactElement | null {
  if (!(failure instanceof ApiFailure)) {
    return null;
  }

  return (
    <Text role="alert" color="danger.fg">
      {describe_unlock_failure(failure)}
    </Text>
  );
}

function describe_unlock_failure(failure: ApiFailure): string {
  if (failure.kind === 'rate_limited') {
    return `Trop d essais depuis votre connexion. Reessayez dans ${describe_delay(failure.retry_after_seconds)}.`;
  }

  if (failure.kind === 'forbidden') {
    return BLOCKED_LINK_MESSAGE;
  }

  if (failure.kind === 'network_unavailable') {
    return 'Impossible de joindre le portail. Verifiez votre connexion.';
  }

  // Tout le reste — code faux, mauvaise longueur, lien mort — porte la MEME
  // phrase, comme l'API porte le meme corps.
  return REJECTED_PIN_MESSAGE;
}

function describe_delay(retry_after_seconds: number | null): string {
  if (retry_after_seconds === null) {
    return 'quelques minutes';
  }

  const minutes: number = Math.ceil(retry_after_seconds / 60);

  return minutes <= 1 ? 'une minute' : `${String(minutes)} minutes`;
}
