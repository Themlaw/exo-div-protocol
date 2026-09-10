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
  | 'not_found'
  | 'file_not_downloadable'
  | 'network_unavailable'
  | 'unexpected';

export class ApiFailure extends Error {
  readonly kind: ApiFailureKind;
  readonly http_status: number | null;
  readonly blocking_file_status: DepositedFileStatus | null;
  // Les violations nommees d'un formulaire refuse. Le backend les rend TOUTES
  // d'un coup, a dessein : l'avocat qui decrit dix documents corrige en une
  // passe au lieu de decouvrir ses erreurs une par une.
  readonly violations: readonly string[];

  constructor(details: {
    kind: ApiFailureKind;
    http_status: number | null;
    blocking_file_status?: DepositedFileStatus | null;
    violations?: readonly string[];
  }) {
    super(details.kind);
    this.name = 'ApiFailure';
    this.kind = details.kind;
    this.http_status = details.http_status;
    this.blocking_file_status = details.blocking_file_status ?? null;
    this.violations = details.violations ?? [];
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

  if (response.status === 409) {
    return new ApiFailure({
      kind: 'file_not_downloadable',
      http_status: 409,
      blocking_file_status: read_blocking_file_status(await read_error_body(response)),
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

function read_blocking_file_status(body: unknown): DepositedFileStatus | null {
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    return null;
  }

  const announced_status: unknown = (body as { status: unknown }).status;

  return DEPOSITED_FILE_STATUSES.includes(announced_status as DepositedFileStatus)
    ? (announced_status as DepositedFileStatus)
    : null;
}
