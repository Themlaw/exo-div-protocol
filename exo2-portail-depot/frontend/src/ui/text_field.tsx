import { useId, type ReactElement } from 'react';
import { Stack, Text, chakra, useRecipe } from '@chakra-ui/react';

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly on_change: (value: string) => void;
  readonly type?: 'text' | 'email' | 'password' | 'number';
  readonly is_disabled?: boolean;
  readonly error_message?: string | undefined;
}

export function TextField({
  label,
  value,
  on_change,
  type = 'text',
  is_disabled = false,
  error_message,
}: TextFieldProps): ReactElement {
  const recipe = useRecipe({ key: 'textField' });
  // Le `label` est LIE au champ, jamais seulement pose a cote : c'est la seule
  // facon pour un lecteur d'ecran — et pour les tests — de savoir lequel des
  // deux champs on remplit.
  const field_id: string = useId();
  const error_id: string = `${field_id}-error`;

  return (
    <Stack gap="1">
      <chakra.label htmlFor={field_id} fontWeight="heading">
        {label}
      </chakra.label>
      <chakra.input
        id={field_id}
        css={recipe()}
        type={type}
        value={value}
        disabled={is_disabled}
        aria-invalid={error_message !== undefined}
        aria-describedby={error_message === undefined ? undefined : error_id}
        onChange={(event) => on_change(event.target.value)}
      />
      {error_message === undefined ? null : (
        <Text id={error_id} color="danger.fg">
          {error_message}
        </Text>
      )}
    </Stack>
  );
}
