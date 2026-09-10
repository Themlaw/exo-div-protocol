import {
  bootstrap_demo_deposit_request,
  DEMO_DEPOSIT_REQUEST,
  type DemoDepositRequestRepository,
} from '../../../src/deposit/demo_deposit_request_bootstrap';
import { validate_deposit_request_creation } from '../../../src/domain/expected_document';
import { DEFAULT_SECURITY_POLICY } from '../../../src/domain/security_policy';

const AN_OWNER_USER_ID = 'e0e3f9f2-1a4b-4c3d-8e5f-6a7b8c9d0e1f';

function build_repository(existing_request_count: number): DemoDepositRequestRepository & {
  created_inputs: unknown[];
} {
  const created_inputs: unknown[] = [];

  return {
    created_inputs,
    count_for_owner: async (): Promise<number> => existing_request_count,
    create: async (input): Promise<string> => {
      created_inputs.push(input);
      return 'un-identifiant';
    },
  };
}

describe('bootstrap_demo_deposit_request', () => {
  it('cree la demande de demonstration sur une base vierge', async () => {
    // L'enonce demande « au moins une demande seedee » : sans elle, l'evaluateur
    // qui se connecte tombe sur une liste vide et doit deviner par ou commencer.
    const repository = build_repository(0);

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID },
      { deposit_requests: repository },
    );

    expect(outcome).toEqual({ deposit_request_was_created: true });
    expect(repository.created_inputs).toEqual([
      {
        owner_user_id: AN_OWNER_USER_ID,
        creation: DEMO_DEPOSIT_REQUEST,
        security_policy: DEFAULT_SECURITY_POLICY,
      },
    ]);
  });

  it('ne cree rien si l avocat a deja une demande', async () => {
    // L'amorcage tourne a CHAQUE demarrage. Sans ce garde, chaque redemarrage
    // ajouterait une demande, et un conteneur qui redemarre en boucle noierait
    // le vrai travail de l'avocat sous des demandes de demonstration.
    const repository = build_repository(1);

    const outcome = await bootstrap_demo_deposit_request(
      { owner_user_id: AN_OWNER_USER_ID },
      { deposit_requests: repository },
    );

    expect(outcome).toEqual({ deposit_request_was_created: false });
    expect(repository.created_inputs).toHaveLength(0);
  });

  it('la demande de demonstration est une demande VALIDE', async () => {
    // Elle passe par les memes regles que celle d'un avocat : une demande seedee
    // que le formulaire aurait refusee serait une demonstration de ce que le
    // produit ne sait pas faire.
    expect(validate_deposit_request_creation(DEMO_DEPOSIT_REQUEST)).toEqual([]);
  });

  it('la demande de demonstration montre plusieurs emplacements et plusieurs types', async () => {
    // Un seul emplacement PDF ne montrerait ni la numerotation, ni le fait que
    // chaque emplacement porte ses propres contraintes.
    expect(DEMO_DEPOSIT_REQUEST.expected_documents.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(DEMO_DEPOSIT_REQUEST.expected_documents.flatMap((document) => document.allowed_mime_types))
        .size,
    ).toBeGreaterThanOrEqual(2);
  });
});
