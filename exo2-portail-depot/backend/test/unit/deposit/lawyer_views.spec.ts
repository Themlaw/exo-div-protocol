import {
  build_lawyer_expected_document_views,
  type LawyerExpectedDocumentView,
} from '../../../src/deposit/lawyer_deposit_views';
import { to_lawyer_activity_event_view } from '../../../src/domain/activity_event';
import type { ActivityEvent, LawyerActivityEventView } from '../../../src/domain/activity_event';
import type { DepositedFile } from '../../../src/domain/deposited_file';
import {
  REFERENCE_NOW,
  add_minutes,
  build_deposited_file,
  build_expected_document,
  build_recorded_activity_event,
} from '../../fixtures/domain_builders';

describe('vue des emplacements attendus rendue a l avocat', () => {
  it('rend null sur un emplacement qu aucune piece n occupe', () => {
    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [build_expected_document({ id: 'emplacement-vide' })],
      [],
    );

    expect(views).toEqual([
      {
        id: 'emplacement-vide',
        label: 'Contrat signe',
        position: 1,
        allowed_mime_types: ['application/pdf', 'image/jpeg'],
        max_size_bytes: 20 * 1024 * 1024,
        deposited_file: null,
      },
    ]);
  });

  // La cle de l'objet est un secret d'infrastructure : la rendre offrirait une
  // cible nommee a qui obtiendrait par ailleurs un acces au stockage.
  it("ne rend jamais la cle de l'objet", () => {
    const file: DepositedFile = build_deposited_file({ status: 'clean' });

    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [build_expected_document()],
      [file],
    );

    expect(Object.keys(views[0]?.deposited_file ?? {})).toEqual([
      'id',
      'display_filename',
      'declared_mime_type',
      'size_bytes',
      'status',
      'uploaded_at',
      'scanned_at',
    ]);
  });

  it("rend la taille reellement mesuree, et rien tant qu'elle est inconnue", () => {
    const arrived: DepositedFile = build_deposited_file({
      id: 'file-arrivee',
      expected_document_id: 'emplacement-1',
      status: 'clean',
      declared_size_bytes: 999,
      actual_size_bytes: 4096,
    });
    const reserved: DepositedFile = build_deposited_file({
      id: 'file-reservee',
      expected_document_id: 'emplacement-2',
      status: 'pending_upload',
      declared_size_bytes: 999,
      actual_size_bytes: null,
    });

    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [
        build_expected_document({ id: 'emplacement-1' }),
        build_expected_document({ id: 'emplacement-2' }),
      ],
      [arrived, reserved],
    );

    expect(views[0]?.deposited_file?.size_bytes).toBe(4096);
    // La taille ANNONCEE n'est qu'une declaration du client : la rendre comme
    // une mesure ferait afficher un poids que personne n'a verifie.
    expect(views[1]?.deposited_file?.size_bytes).toBeNull();
  });

  // Un emplacement peut porter plusieurs lignes dans le temps : une piece
  // refusee, puis une nouvelle tentative. L'avocat veut voir la DERNIERE, celle
  // qui raconte ou en est l'emplacement aujourd'hui.
  it('retient la piece la plus recente quand un emplacement en a porte plusieurs', () => {
    const rejected: DepositedFile = build_deposited_file({
      id: 'file-refusee',
      status: 'rejected',
      created_at: add_minutes(REFERENCE_NOW, -30),
    });
    const latest: DepositedFile = build_deposited_file({
      id: 'file-courante',
      status: 'pending_scan',
      created_at: REFERENCE_NOW,
    });

    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [build_expected_document()],
      [rejected, latest],
    );

    expect(views[0]?.deposited_file?.id).toBe('file-courante');
  });

  it('rend les emplacements dans leur ordre de position', () => {
    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [
        build_expected_document({ id: 'troisieme', position: 3 }),
        build_expected_document({ id: 'premier', position: 1 }),
        build_expected_document({ id: 'second', position: 2 }),
      ],
      [],
    );

    expect(views.map((view: LawyerExpectedDocumentView): string => view.id)).toEqual([
      'premier',
      'second',
      'troisieme',
    ]);
  });

  // Une piece dont l'emplacement a disparu ne s'accroche a rien : elle ne doit
  // surtout pas se rabattre sur le premier emplacement venu.
  it('ignore une piece dont l emplacement n est pas dans la liste', () => {
    const orphan: DepositedFile = build_deposited_file({
      expected_document_id: 'emplacement-disparu',
      status: 'clean',
    });

    const views: LawyerExpectedDocumentView[] = build_lawyer_expected_document_views(
      [build_expected_document({ id: 'emplacement-present' })],
      [orphan],
    );

    expect(views[0]?.deposited_file).toBeNull();
  });
});

describe('vue du journal rendue a l avocat', () => {
  // LE point de l'arbitrage : l'adresse ne quitte jamais la base. Rendue au
  // navigateur, elle finirait dans une capture d'ecran et un PDF imprime, deux
  // endroits que la purge a trente jours n'atteindra jamais.
  it("n'expose jamais l'adresse du client", () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'client_pin_rejected',
      client_ip: '203.0.113.42',
    });

    const view: LawyerActivityEventView = to_lawyer_activity_event_view(recorded);

    expect(Object.keys(view)).toEqual([
      'id',
      'type',
      'actor',
      'access_link_id',
      'deposited_file_id',
      'occurred_at',
    ]);
    expect(JSON.stringify(view)).not.toContain('203.0.113.42');
  });

  it("conserve l'acteur, les sujets et l'instant", () => {
    const recorded: ActivityEvent = build_recorded_activity_event({
      type: 'deposited_file_downloaded',
      actor: { kind: 'lawyer', user_id: 'lawyer-1' },
      deposited_file_id: 'file-1',
    });

    expect(to_lawyer_activity_event_view(recorded)).toEqual({
      id: recorded.id,
      type: 'deposited_file_downloaded',
      actor: { kind: 'lawyer', user_id: 'lawyer-1' },
      access_link_id: recorded.access_link_id,
      deposited_file_id: 'file-1',
      occurred_at: REFERENCE_NOW,
    });
  });
});
