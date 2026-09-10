import type { DepositRequestCreationInput } from '../domain/expected_document';
import { DEFAULT_SECURITY_POLICY } from '../domain/security_policy';
import type { SecurityPolicy } from '../domain/security_policy';

// Ce que l'evaluateur voit en se connectant. Trois emplacements et non un : un
// seul ne montrerait ni la numerotation, ni le fait que chaque emplacement porte
// ses propres types et sa propre taille limite — c'est-a-dire l'essentiel de ce
// que le formulaire de creation permet d'exprimer.
//
// Aucune piece n'est deposee a l'amorcage : deposer demanderait de fabriquer un
// objet dans MinIO et un verdict de scan que personne n'a rendu, donc d'ecrire
// en base un etat qu'aucun chemin reel n'a produit. La demande est vide, comme
// elle l'est une seconde apres sa creation par un avocat.
export const DEMO_DEPOSIT_REQUEST: DepositRequestCreationInput = {
  title: 'Dossier de demonstration — succession Martin',
  expected_documents: [
    {
      label: "Piece d'identite",
      position: 1,
      allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png'],
      max_size_bytes: 5 * 1024 * 1024,
    },
    {
      label: 'Acte de deces',
      position: 2,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 10 * 1024 * 1024,
    },
    {
      label: 'Releve de compte des douze derniers mois',
      position: 3,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 20 * 1024 * 1024,
    },
  ],
};

// Le strict necessaire a l'amorcage, et pas le depot complet : ce module n'a
// aucune raison de connaitre les vues, les statuts ni les pieces.
export interface DemoDepositRequestRepository {
  count_for_owner(owner_user_id: string): Promise<number>;
  create(input: {
    owner_user_id: string;
    creation: DepositRequestCreationInput;
    security_policy: SecurityPolicy;
  }): Promise<string>;
}

export interface DemoDepositRequestBootstrapOutcome {
  deposit_request_was_created: boolean;
}

export async function bootstrap_demo_deposit_request(
  input: { owner_user_id: string },
  dependencies: { deposit_requests: DemoDepositRequestRepository },
): Promise<DemoDepositRequestBootstrapOutcome> {
  // « L'avocat n'a AUCUNE demande », et non « cette demande-ci n'existe pas » :
  // l'amorcage tourne a chaque demarrage, et reconnaitre la demande a son titre
  // la recreerait des que quelqu'un la renomme ou la supprime. Une base vierge
  // est le seul etat ou amorcer ait un sens.
  if ((await dependencies.deposit_requests.count_for_owner(input.owner_user_id)) > 0) {
    return { deposit_request_was_created: false };
  }

  await dependencies.deposit_requests.create({
    owner_user_id: input.owner_user_id,
    creation: DEMO_DEPOSIT_REQUEST,
    // La politique par defaut, celle que le formulaire propose : une demande de
    // demonstration reglee autrement montrerait un produit qui n'existe pas.
    security_policy: DEFAULT_SECURITY_POLICY,
  });

  return { deposit_request_was_created: true };
}
