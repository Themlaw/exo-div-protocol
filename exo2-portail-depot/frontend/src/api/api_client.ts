import { DEPOSITED_FILE_STATUSES, type DepositedFileStatus } from './contracts';

// Le front et l'API partagent l'origine (Traefik en production, le mandataire
// de Vite en developpement) : un chemin relatif suffit, et il evite d'avoir a
// configurer une URL par environnement.
export const API_BASE_PATH = '/api/v1';

// Chaque cas porte une phrase differente a l'ecran. Les fondre en un seul
// « une erreur est survenue » ferait chercher une panne de reseau a qui a
// simplement suivi un vieux lien.
export type ApiFailureKind =
  | 'rejected_payload'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'file_not_downloadable'
  | 'refused_upload'
  | 'rate_limited'
  | 'network_unavailable'
  | 'unexpected';

// Les deux seuls refus d'envoi que le backend EXPLIQUE, et il les explique parce
// que le client peut y remedier : changer de fichier, ou en prendre un plus
// leger. Tous les autres restent muets.
export type UploadRefusal =
  | { readonly reason: 'mime_type_not_allowed'; readonly allowed_mime_types: readonly string[] }
  | { readonly reason: 'declared_size_above_limit'; readonly max_size_bytes: number };

export class ApiFailure extends Error {
  readonly kind: ApiFailureKind;
  readonly http_status: number | null;
  readonly blocking_file_status: DepositedFileStatus | null;
  // Les violations nommees d'un formulaire refuse. Le backend les rend TOUTES
  // d'un coup, a dessein : l'avocat qui decrit dix documents corrige en une
  // passe au lieu de decouvrir ses erreurs une par une.
  readonly violations: readonly string[];
  // Le delai annonce par `Retry-After`. C'est le SEUL refus qui s'explique cote
  // client anonyme, parce qu'il parle de son adresse et non du lien : sans lui,
  // un destinataire legitime redemanderait un lien au lieu de patienter.
  readonly retry_after_seconds: number | null;
  readonly upload_refusal: UploadRefusal | null;

  constructor(details: {
    kind: ApiFailureKind;
    http_status: number | null;
    blocking_file_status?: DepositedFileStatus | null;
    violations?: readonly string[];
    retry_after_seconds?: number | null;
    upload_refusal?: UploadRefusal | null;
  }) {
    super(details.kind);
    this.name = 'ApiFailure';
    this.kind = details.kind;
    this.http_status = details.http_status;
    this.blocking_file_status = details.blocking_file_status ?? null;
    this.violations = details.violations ?? [];
    this.retry_after_seconds = details.retry_after_seconds ?? null;
    this.upload_refusal = details.upload_refusal ?? null;
  }
}

export async function request_api<Payload>(
  path: string,
  init: RequestInit = {},
): Promise<Payload> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_PATH}${path}`, {
      ...init,
      // `fetch` n'envoie AUCUN cookie par defaut, meme de meme origine, des
      // qu'on lui passe des options : sans cette ligne toute la console avocat
      // repondrait 401.
      credentials: 'include',
    });
  } catch {
    // `fetch` ne rejette que sur une panne de transport. C'est le seul endroit
    // ou « verifiez votre connexion » est la bonne phrase.
    throw new ApiFailure({ kind: 'network_unavailable', http_status: null });
  }

  if (!response.ok) {
    throw await read_api_failure(response);
  }

  return (await read_successful_payload<Payload>(response));
}

async function read_successful_payload<Payload>(response: Response): Promise<Payload> {
  // Un 204 n'a pas de corps : le lire en JSON leverait la ou tout s'est bien
  // passe.
  if (response.status === 204) {
    return undefined as Payload;
  }

  return (await response.json()) as Payload;
}

async function read_api_failure(response: Response): Promise<ApiFailure> {
  if (response.status === 401) {
    return new ApiFailure({ kind: 'unauthenticated', http_status: 401 });
  }

  if (response.status === 404) {
    return new ApiFailure({ kind: 'not_found', http_status: 404 });
  }

  if (response.status === 400) {
    return new ApiFailure({
      kind: 'rejected_payload',
      http_status: 400,
      violations: read_violations(await read_error_body(response)),
    });
  }

  if (response.status === 403) {
    return new ApiFailure({ kind: 'forbidden', http_status: 403 });
  }

  if (response.status === 409) {
    // Un 409 QUI PORTE un statut de piece est un refus de telechargement : la
    // piece appartient bien a l'avocat, et c'est ce statut qui lui permet de
    // lire « en quarantaine » plutot que « introuvable ». Les autres 409 —
    // emplacement occupe, demande gelee — n'en portent pas.
    const blocking_file_status: DepositedFileStatus | null = read_blocking_file_status(
      await read_error_body(response),
    );

    return new ApiFailure({
      kind: blocking_file_status === null ? 'conflict' : 'file_not_downloadable',
      http_status: 409,
      blocking_file_status,
    });
  }

  if (response.status === 422) {
    return new ApiFailure({
      kind: 'refused_upload',
      http_status: 422,
      upload_refusal: read_upload_refusal(await read_error_body(response)),
    });
  }

  if (response.status === 429) {
    return new ApiFailure({
      kind: 'rate_limited',
      http_status: 429,
      retry_after_seconds: read_retry_after_seconds(response),
    });
  }

  return new ApiFailure({ kind: 'unexpected', http_status: response.status });
}

// Le mandataire rend ses propres erreurs en HTML : analyser le corps sans filet
// remplacerait le vrai statut du serveur par une erreur d'analyse, et l'ecran
// afficherait une panne inventee a la place de celle qui s'est produite.
async function read_error_body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function read_violations(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null || !('violations' in body)) {
    return [];
  }

  const announced_violations: unknown = (body as { violations: unknown }).violations;

  if (!Array.isArray(announced_violations)) {
    return [];
  }

  return announced_violations.filter(
    (violation: unknown): violation is string => typeof violation === 'string',
  );
}

function read_retry_after_seconds(response: Response): number | null {
  const announced_delay: number = Number.parseInt(
    response.headers.get('retry-after') ?? '',
    10,
  );

  return Number.isSafeInteger(announced_delay) && announced_delay >= 0 ? announced_delay : null;
}

function read_upload_refusal(body: unknown): UploadRefusal | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const { reason, allowed_mime_types, max_size_bytes } = body as Record<string, unknown>;

  if (
    reason === 'mime_type_not_allowed' &&
    Array.isArray(allowed_mime_types) &&
    allowed_mime_types.every((mime_type: unknown): boolean => typeof mime_type === 'string')
  ) {
    return { reason, allowed_mime_types: allowed_mime_types as readonly string[] };
  }

  if (reason === 'declared_size_above_limit' && Number.isSafeInteger(max_size_bytes)) {
    return { reason, max_size_bytes: max_size_bytes as number };
  }

  return null;
}

function read_blocking_file_status(body: unknown): DepositedFileStatus | null {
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    return null;
  }

  const announced_status: unknown = (body as { status: unknown }).status;

  return DEPOSITED_FILE_STATUSES.includes(announced_status as DepositedFileStatus)
    ? (announced_status as DepositedFileStatus)
    : null;
}
