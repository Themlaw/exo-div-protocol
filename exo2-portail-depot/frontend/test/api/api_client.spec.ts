import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_BASE_PATH,
  ApiFailure,
  request_api,
} from '../../src/api/api_client';
import type { PresignedDownloadTicket } from '../../src/api/contracts';

function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Client d API', () => {
  const fetch_spy = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch_spy);
  });

  afterEach(() => {
    fetch_spy.mockReset();
    vi.unstubAllGlobals();
  });

  it('adresse le chemin versionne et joint le cookie de session', async () => {
    fetch_spy.mockResolvedValue(json_response(200, { deposit_requests: [] }));

    await request_api('/deposit-requests');

    expect(fetch_spy).toHaveBeenCalledTimes(1);
    const [requested_url, requested_init] = fetch_spy.mock.calls[0] as [string, RequestInit];

    expect(requested_url).toBe(`${API_BASE_PATH}/deposit-requests`);
    // Sans `include`, le navigateur n'enverrait pas le cookie de session avocat
    // et chaque appel reviendrait en 401 : c'est le defaut de `fetch`.
    expect(requested_init.credentials).toBe('include');
  });

  it('distingue la session expiree, seul cas qui doit ramener a la connexion', async () => {
    fetch_spy.mockResolvedValue(json_response(401, { message: 'Non authentifie' }));

    const failure: ApiFailure = await expect_api_failure(request_api('/deposit-requests'));

    expect(failure.kind).toBe('unauthenticated');
    expect(failure.http_status).toBe(401);
  });

  it('distingue la ressource introuvable d une panne de reseau', async () => {
    fetch_spy.mockResolvedValue(json_response(404, { message: 'Ressource introuvable' }));
    const missing: ApiFailure = await expect_api_failure(request_api('/deposit-requests/inconnu'));

    // `fetch` ne rejette QUE sur une panne de transport : un 404 est une reponse
    // reussie. Les confondre afficherait « verifiez votre connexion » a un
    // avocat parfaitement connecte qui a juste suivi un vieux lien.
    fetch_spy.mockRejectedValue(new TypeError('Failed to fetch'));
    const unreachable: ApiFailure = await expect_api_failure(request_api('/deposit-requests'));

    expect(missing.kind).toBe('not_found');
    expect(unreachable.kind).toBe('network_unavailable');
    expect(unreachable.http_status).toBeNull();
  });

  it('remonte le statut de la piece quand le telechargement est refuse', async () => {
    // Le backend ne repond 409 que sur une piece qui appartient bien a l'avocat :
    // le statut qu'il joint est ce qui permet d'ecrire « en quarantaine » plutot
    // que « introuvable ».
    fetch_spy.mockResolvedValue(json_response(409, { status: 'infected' }));

    const failure: ApiFailure = await expect_api_failure(
      request_api<PresignedDownloadTicket>('/deposit-requests/d1/files/f1/download'),
    );

    expect(failure.kind).toBe('file_not_downloadable');
    expect(failure.blocking_file_status).toBe('infected');
  });

  it('remonte toutes les violations d un formulaire refuse', async () => {
    // Le backend rend la liste complete a dessein : l'afficher entiere permet a
    // l'avocat de corriger ses dix documents en une passe.
    fetch_spy.mockResolvedValue(
      json_response(400, {
        violations: ['title_missing', 'expected_document_label_missing'],
      }),
    );

    const failure: ApiFailure = await expect_api_failure(
      request_api('/requests', { method: 'POST' }),
    );

    expect(failure.kind).toBe('rejected_payload');
    expect(failure.violations).toEqual(['title_missing', 'expected_document_label_missing']);
  });

  it('survit a un corps d erreur qui n est pas du JSON', async () => {
    // Un 502 rendu par le mandataire arrive en HTML : le client ne doit pas
    // remplacer l'erreur du serveur par une erreur d'analyse.
    fetch_spy.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const failure: ApiFailure = await expect_api_failure(request_api('/deposit-requests'));

    expect(failure.kind).toBe('unexpected');
    expect(failure.http_status).toBe(502);
    expect(failure.blocking_file_status).toBeNull();
  });
});

async function expect_api_failure(pending: Promise<unknown>): Promise<ApiFailure> {
  try {
    await pending;
  } catch (thrown: unknown) {
    expect(thrown).toBeInstanceOf(ApiFailure);

    return thrown as ApiFailure;
  }

  throw new Error('La requete a reussi alors que le test attendait un echec.');
}
