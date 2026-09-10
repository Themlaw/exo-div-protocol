import { vi } from 'vitest';

import type {
  ClientDepositBoardView,
  ClientExpectedDocumentView,
  ClientUploadTicketView,
} from '../../src/api/contracts';

export const LINK_TOKEN = 'aB3cD4eF5gH6';
export const DEPOSIT_ENTRY_PATH = `/deposit/${LINK_TOKEN}`;

export const IDENTITY_DOCUMENT: ClientExpectedDocumentView = {
  id: 'doc-identite',
  label: "Piece d'identite",
  position: 1,
  allowed_mime_types: ['application/pdf'],
  max_size_bytes: 5 * 1024 * 1024,
  deposited_file: null,
};

export const HOUSING_DOCUMENT: ClientExpectedDocumentView = {
  id: 'doc-domicile',
  label: 'Justificatif de domicile',
  position: 2,
  allowed_mime_types: ['application/pdf', 'image/jpeg'],
  max_size_bytes: 20 * 1024 * 1024,
  deposited_file: {
    id: 'fichier-domicile',
    display_filename: 'edf.pdf',
    status: 'clean',
  },
};

export const DEPOSIT_BOARD: ClientDepositBoardView = {
  title: 'Dossier Martin, pieces 2026',
  deposit_request_status: 'incomplete',
  session_expires_at: '2026-09-11T10:30:00.000Z',
  expected_documents: [IDENTITY_DOCUMENT, HOUSING_DOCUMENT],
};

export const UPLOAD_TICKET: ClientUploadTicketView = {
  deposited_file_id: 'fichier-identite',
  upload_url: 'https://stockage.example/quarantaine',
  form_fields: { key: 'quarantaine/fichier-identite', policy: 'une-politique-signee' },
  expires_at: '2026-09-11T10:05:00.000Z',
};

export interface ClientApiOverrides {
  readonly board?: ClientDepositBoardView;
  readonly upload_authorization?: Response;
  readonly removal?: Response;
  readonly completion?: Response;
}

// Le meme faux backend pour les trois suites du parcours client : une reponse
// recopiee d'un fichier a l'autre finit par diverger de la vraie API sans que
// rien ne le signale.
export function stub_client_deposit_api(
  overrides: ClientApiOverrides = {},
): ReturnType<typeof vi.fn> {
  const fetch_spy = vi.fn<typeof fetch>();

  fetch_spy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);

    if (path.endsWith('/uploads') && init?.method === 'POST') {
      return Promise.resolve(overrides.upload_authorization ?? json_response(201, UPLOAD_TICKET));
    }

    if (path.endsWith('/completion') && init?.method === 'POST') {
      return Promise.resolve(overrides.completion ?? json_response(200, { status: 'processing' }));
    }

    if (init?.method === 'DELETE') {
      return Promise.resolve(overrides.removal ?? new Response(null, { status: 204 }));
    }

    if (path.endsWith('/documents')) {
      return Promise.resolve(json_response(200, overrides.board ?? DEPOSIT_BOARD));
    }

    return Promise.resolve(json_response(200, { state: 'active', pin_length: 6 }));
  });

  vi.stubGlobal('fetch', fetch_spy);

  return fetch_spy;
}

export function json_response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
