import { describe, expect, it } from 'vitest';

import { should_poll_deposit_board } from '../../src/api/client_queries';
import type { ClientDepositBoardView, DepositedFileStatus } from '../../src/api/contracts';

function a_board_whose_only_piece_is(status: DepositedFileStatus | null): ClientDepositBoardView {
  return {
    title: 'Dossier Martin',
    deposit_request_status: 'incomplete',
    session_expires_at: '2026-09-11T10:30:00.000Z',
    expected_documents: [
      {
        id: 'doc-identite',
        label: "Piece d'identite",
        position: 1,
        allowed_mime_types: ['application/pdf'],
        max_size_bytes: 1024,
        deposited_file:
          status === null ? null : { id: 'fichier', display_filename: 'cni.pdf', status },
      },
    ],
  };
}

describe('Relecture du tableau de depot', () => {
  it('continue tant qu un envoi n a pas ete constate par le serveur', () => {
    // Le cas que la reponse ne peut PAS decrire : les octets sont partis vers
    // MinIO, mais tant que le webhook n'est pas passe la piece n'occupe pas son
    // emplacement, et le tableau la montre vide. S'en remettre au seul contenu
    // de la reponse arreterait la relecture exactement quand elle sert.
    expect(should_poll_deposit_board(a_board_whose_only_piece_is(null), true)).toBe(true);
  });

  it('continue tant qu une piece attend son verdict', () => {
    expect(should_poll_deposit_board(a_board_whose_only_piece_is('pending_scan'), false)).toBe(
      true,
    );
  });

  it('s arrete des que tout est tranche', () => {
    // Une relecture qui ne s'arrete jamais est un appel toutes les trois
    // secondes pendant toute la duree de la session.
    expect(should_poll_deposit_board(a_board_whose_only_piece_is('clean'), false)).toBe(false);
    expect(should_poll_deposit_board(a_board_whose_only_piece_is('infected'), false)).toBe(false);
    expect(should_poll_deposit_board(a_board_whose_only_piece_is(null), false)).toBe(false);
  });

  it('ne relit rien avant d avoir recu un premier tableau', () => {
    expect(should_poll_deposit_board(undefined, false)).toBe(false);
  });
});
