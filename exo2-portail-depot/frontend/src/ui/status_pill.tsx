import type { ReactElement } from 'react';
import { chakra, useRecipe } from '@chakra-ui/react';

import type { DepositRequestStatus, DepositedFileStatus } from '../api/contracts';

export type StatusTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info';

// Les libelles et les couleurs sont ceux valides dans `statuts-et-depot.md` :
// incomplet gris, en traitement orange, valide vert, bloque et expire rouges.
// Les ecrire ici, une fois, evite qu'un meme statut change de mot d'un ecran a
// l'autre.
const DEPOSIT_REQUEST_STATUS_PRESENTATION: Readonly<
  Record<DepositRequestStatus, { label: string; tone: StatusTone }>
> = {
  incomplete: { label: 'Incomplet', tone: 'neutral' },
  processing: { label: 'En traitement', tone: 'warning' },
  validated: { label: 'Valide', tone: 'success' },
  blocked: { label: 'Bloque', tone: 'danger' },
  expired_incomplete: { label: 'Expire incomplet', tone: 'danger' },
};

// Le vocabulaire de l'avocat n'est pas celui de la machine : « en quarantaine »
// dit ce qu'il doit faire — rien — la ou « infected » decrit un verdict.
const DEPOSITED_FILE_STATUS_PRESENTATION: Readonly<
  Record<DepositedFileStatus, { label: string; tone: StatusTone }>
> = {
  pending_upload: { label: 'Attendue', tone: 'neutral' },
  pending_scan: { label: 'En analyse', tone: 'info' },
  clean: { label: 'Deposee', tone: 'success' },
  infected: { label: 'En quarantaine', tone: 'danger' },
  rejected: { label: 'Refusee', tone: 'danger' },
};

export function deposit_request_status_label(status: DepositRequestStatus): string {
  return DEPOSIT_REQUEST_STATUS_PRESENTATION[status].label;
}

export function deposited_file_status_label(status: DepositedFileStatus): string {
  return DEPOSITED_FILE_STATUS_PRESENTATION[status].label;
}

export interface StatusPillProps {
  readonly label: string;
  readonly tone: StatusTone;
}

export function StatusPill({ label, tone }: StatusPillProps): ReactElement {
  const recipe = useRecipe({ key: 'statusPill' });

  return <chakra.span css={recipe({ tone })}>{label}</chakra.span>;
}

export function DepositRequestStatusPill({
  status,
}: {
  readonly status: DepositRequestStatus;
}): ReactElement {
  const presentation = DEPOSIT_REQUEST_STATUS_PRESENTATION[status];

  return <StatusPill label={presentation.label} tone={presentation.tone} />;
}

export function DepositedFileStatusPill({
  status,
}: {
  readonly status: DepositedFileStatus;
}): ReactElement {
  const presentation = DEPOSITED_FILE_STATUS_PRESENTATION[status];

  return <StatusPill label={presentation.label} tone={presentation.tone} />;
}
