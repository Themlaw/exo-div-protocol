import { useState, type FormEvent, type ReactElement } from 'react';
import { Flex, Heading, Stack, Text, chakra } from '@chakra-ui/react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';

import { ApiFailure } from '../api/api_client';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDS,
  type AccessLinkDelivery,
  type SecurityPolicy,
} from '../api/contracts';
import {
  use_create_deposit_request,
  type DepositRequestCreationBody,
  type DepositRequestCreationResult,
} from '../api/lawyer_queries';
import { violation_messages } from '../api/violation_messages';
import { LAWYER_DEPOSIT_REQUESTS_PATH } from '../routing/front_routes';
import { PrimaryButton, SecondaryButton } from '../ui/div_button';
import { DivCard } from '../ui/div_card';
import { TextField } from '../ui/text_field';
import { AccessLinkDeliveryDialog } from './access_link_delivery_dialog';

// Les formats sont proposes plutot que saisis : un type MIME tape a la main est
// un type MIME faux, et la liste blanche est le seul rempart avant le scan.
const OFFERED_MIME_TYPES: readonly { readonly label: string; readonly mime_type: string }[] = [
  { label: 'PDF', mime_type: 'application/pdf' },
  { label: 'JPEG', mime_type: 'image/jpeg' },
  { label: 'PNG', mime_type: 'image/png' },
];

// Le plafond de plateforme de l'enonce. L'avocat peut resserrer, jamais elargir.
const PLATFORM_MAXIMUM_SIZE_MEGABYTES = 20;
const BYTES_PER_MEGABYTE = 1024 * 1024;

interface ExpectedDocumentDraft {
  readonly local_key: string;
  readonly label: string;
  readonly allowed_mime_types: readonly string[];
  readonly max_size_megabytes: number;
}

// Un champ par reglage, et son intitule dans les mots de l'avocat : « essais de
// code » plutot que `max_pin_attempts`. L'ordre suit ce qu'il decide en premier
// — combien de temps le lien vit, puis a quel point le code est difficile.
const SECURITY_POLICY_FIELDS: readonly {
  readonly key: keyof SecurityPolicy;
  readonly label: string;
  readonly explanation: string;
}[] = [
  {
    key: 'link_lifetime_days',
    label: 'Duree de validite du lien (jours)',
    explanation: `Entre ${String(SECURITY_POLICY_BOUNDS.link_lifetime_days.min)} et ${String(SECURITY_POLICY_BOUNDS.link_lifetime_days.max)} jours. Passe ce delai, le client ne peut plus rien deposer.`,
  },
  {
    key: 'pin_length',
    label: 'Longueur du code d acces (chiffres)',
    explanation: `Entre ${String(SECURITY_POLICY_BOUNDS.pin_length.min)} et ${String(SECURITY_POLICY_BOUNDS.pin_length.max)} chiffres. Un code plus long est plus sur, et plus penible a dicter.`,
  },
  {
    key: 'max_pin_attempts',
    label: 'Essais de code autorises',
    explanation: `Entre ${String(SECURITY_POLICY_BOUNDS.max_pin_attempts.min)} et ${String(SECURITY_POLICY_BOUNDS.max_pin_attempts.max)} essais. Au dela, le lien se bloque et il faut le regenerer.`,
  },
];

function empty_expected_document(local_key: string): ExpectedDocumentDraft {
  return {
    local_key,
    label: '',
    allowed_mime_types: [],
    max_size_megabytes: PLATFORM_MAXIMUM_SIZE_MEGABYTES,
  };
}

export function NewDepositRequestScreen(): ReactElement {
  const navigate: NavigateFunction = useNavigate();
  const [title, set_title] = useState<string>('');
  const [drafts, set_drafts] = useState<readonly ExpectedDocumentDraft[]>([
    empty_expected_document('document-1'),
  ]);
  // La politique part sur les valeurs du domaine : l'avocat qui n'y touche pas
  // doit obtenir exactement le comportement d'avant, sans avoir a le savoir.
  const [security_policy, set_security_policy] = useState<SecurityPolicy>({
    ...DEFAULT_SECURITY_POLICY,
  });
  const [created, set_created] = useState<DepositRequestCreationResult | null>(null);
  const creation = use_create_deposit_request();

  function add_expected_document(): void {
    set_drafts((current: readonly ExpectedDocumentDraft[]) => [
      ...current,
      empty_expected_document(`document-${String(Date.now())}-${String(current.length)}`),
    ]);
  }

  function remove_expected_document(local_key: string): void {
    set_drafts((current: readonly ExpectedDocumentDraft[]) =>
      current.length === 1
        ? current
        : current.filter((draft: ExpectedDocumentDraft) => draft.local_key !== local_key),
    );
  }

  function update_expected_document(
    local_key: string,
    change: Partial<Omit<ExpectedDocumentDraft, 'local_key'>>,
  ): void {
    set_drafts((current: readonly ExpectedDocumentDraft[]) =>
      current.map((draft: ExpectedDocumentDraft) =>
        draft.local_key === local_key ? { ...draft, ...change } : draft,
      ),
    );
  }

  function submit_creation(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    creation.mutate(to_creation_body(title, drafts, security_policy), {
      onSuccess: (result: DepositRequestCreationResult): void => {
        set_created(result);
      },
    });
  }

  return (
    <Stack gap="6" maxWidth="46rem" marginX="auto" paddingY="10" paddingX="4">
      <Heading size="lg">Faire une nouvelle demande</Heading>

      <form onSubmit={submit_creation} noValidate>
        <Stack gap="6">
          <TextField label="Titre de la demande" value={title} on_change={set_title} />

          <Stack gap="4">
            {drafts.map((draft: ExpectedDocumentDraft, index: number) => (
              <ExpectedDocumentFieldset
                key={draft.local_key}
                draft={draft}
                position={index + 1}
                can_be_removed={drafts.length > 1}
                on_change={(change) => update_expected_document(draft.local_key, change)}
                on_remove={() => remove_expected_document(draft.local_key)}
              />
            ))}
          </Stack>

          <SecurityPolicyFieldset
            security_policy={security_policy}
            on_change={(setting: keyof SecurityPolicy, value: number): void =>
              set_security_policy((current: SecurityPolicy) => ({ ...current, [setting]: value }))
            }
          />

          <Flex justifyContent="space-between" gap="4" wrap="wrap">
            <SecondaryButton onClick={add_expected_document}>Ajouter un document</SecondaryButton>
            <PrimaryButton type="submit" disabled={creation.isPending}>
              {creation.isPending ? 'Creation en cours' : 'Creer la demande'}
            </PrimaryButton>
          </Flex>

          <RefusalReport failure={creation.error} />
        </Stack>
      </form>

      {created === null ? null : (
        <AccessLinkDeliveryDialog
          deposit_request_title={title}
          delivery={created.access_link satisfies AccessLinkDelivery}
          on_close={(): void => {
            navigate(`${LAWYER_DEPOSIT_REQUESTS_PATH}/${created.id}`, { replace: true });
          }}
        />
      )}
    </Stack>
  );
}

function SecurityPolicyFieldset({
  security_policy,
  on_change,
}: {
  readonly security_policy: SecurityPolicy;
  readonly on_change: (setting: keyof SecurityPolicy, value: number) => void;
}): ReactElement {
  return (
    <DivCard as="fieldset" role="group" aria-label="Politique de securite">
      <Stack gap="4">
        <Text fontWeight="heading">Politique de securite</Text>

        {SECURITY_POLICY_FIELDS.map((field) => (
          <Stack key={field.key} gap="1">
            <TextField
              label={field.label}
              type="number"
              bounds={SECURITY_POLICY_BOUNDS[field.key]}
              value={String(security_policy[field.key])}
              on_change={(raw: string) => on_change(field.key, read_whole_number(raw))}
            />
            <Text color="gray.default" fontSize="sm">
              {field.explanation}
            </Text>
          </Stack>
        ))}
      </Stack>
    </DivCard>
  );
}

function ExpectedDocumentFieldset({
  draft,
  position,
  can_be_removed,
  on_change,
  on_remove,
}: {
  readonly draft: ExpectedDocumentDraft;
  readonly position: number;
  readonly can_be_removed: boolean;
  readonly on_change: (change: Partial<Omit<ExpectedDocumentDraft, 'local_key'>>) => void;
  readonly on_remove: () => void;
}): ReactElement {
  // Le numero vient de la POSITION dans la liste, jamais d'un compteur retenu a
  // la creation : retirer le premier document doit renumeroter les suivants,
  // sinon l'ecran affiche « Document 2, Document 3 » sans document 1.
  const document_name = `Document ${String(position)}`;

  return (
    <DivCard as="fieldset" role="group" aria-label={document_name}>
      <Stack gap="4">
        <Flex justifyContent="space-between" alignItems="center" gap="4">
          <Text fontWeight="heading">{document_name}</Text>
          <SecondaryButton
            disabled={!can_be_removed}
            aria-label={`Retirer le document ${String(position)}`}
            onClick={on_remove}
          >
            Retirer
          </SecondaryButton>
        </Flex>

        <TextField
          label="Intitule"
          value={draft.label}
          on_change={(label: string) => on_change({ label })}
        />

        <Stack gap="2">
          <Text fontWeight="heading">Formats autorises</Text>
          <Flex gap="4" wrap="wrap">
            {OFFERED_MIME_TYPES.map((offered) => (
              <chakra.label key={offered.mime_type} display="flex" alignItems="center" gap="2">
                <chakra.input
                  type="checkbox"
                  checked={draft.allowed_mime_types.includes(offered.mime_type)}
                  onChange={() =>
                    on_change({
                      allowed_mime_types: toggle_mime_type(
                        draft.allowed_mime_types,
                        offered.mime_type,
                      ),
                    })
                  }
                />
                {offered.label}
              </chakra.label>
            ))}
          </Flex>
        </Stack>

        <TextField
          label="Taille maximale (Mo)"
          type="number"
          value={String(draft.max_size_megabytes)}
          on_change={(raw: string) =>
            on_change({ max_size_megabytes: read_whole_number(raw) })
          }
        />
      </Stack>
    </DivCard>
  );
}

function RefusalReport({ failure }: { readonly failure: ApiFailure | null }): ReactElement | null {
  if (!(failure instanceof ApiFailure)) {
    return null;
  }

  const messages: readonly string[] =
    failure.kind === 'rejected_payload'
      ? violation_messages(failure.violations)
      : ['La demande n a pas pu etre creee. Reessayez dans un instant.'];

  return (
    <Stack role="alert" gap="1" color="danger.fg">
      {messages.map((message: string) => (
        <Text key={message}>{message}</Text>
      ))}
    </Stack>
  );
}

function toggle_mime_type(
  allowed_mime_types: readonly string[],
  mime_type: string,
): readonly string[] {
  return allowed_mime_types.includes(mime_type)
    ? allowed_mime_types.filter((allowed: string) => allowed !== mime_type)
    : [...allowed_mime_types, mime_type];
}

// Un champ vide rend 0 plutot que NaN : `NaN` traverse `JSON.stringify` en
// `null` et le backend repondrait « formulaire illisible » la ou l'avocat a
// simplement efface son champ. A 0, il lit « hors des bornes autorisees », qui
// designe le champ fautif.
function read_whole_number(raw: string): number {
  const parsed: number = Number.parseInt(raw, 10);

  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function to_creation_body(
  title: string,
  drafts: readonly ExpectedDocumentDraft[],
  security_policy: SecurityPolicy,
): DepositRequestCreationBody {
  return {
    title: title.trim(),
    security_policy,
    expected_documents: drafts.map((draft: ExpectedDocumentDraft, index: number) => ({
      label: draft.label.trim(),
      position: index + 1,
      allowed_mime_types: draft.allowed_mime_types,
      max_size_bytes: draft.max_size_megabytes * BYTES_PER_MEGABYTE,
    })),
  };
}
