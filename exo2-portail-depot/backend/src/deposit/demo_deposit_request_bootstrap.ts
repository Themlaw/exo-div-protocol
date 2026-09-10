import type { DepositRequestCreationInput } from '../domain/expected_document';
import { DEFAULT_SECURITY_POLICY } from '../domain/security_policy';
import type { SecurityPolicy } from '../domain/security_policy';
import type { AccessLink } from '../domain/access_link';
import type { AccessLinkIssuance } from '../access_link/access_link_repository';
import type {
  AccessLinkTokenFingerprint,
  AccessLinkTokenHasher,
} from '../access_link/access_link_token_hasher';
import type { PinHasher } from '../domain/verify_client_pin';
import { build_activity_event } from '../domain/activity_event';
import type { NewActivityEvent } from '../domain/activity_event';
import type { Clock } from '../shared/clock';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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

// Le jeton et le PIN du lien de demonstration, tels que le README les publie et
// que `install.sh` les affiche. Ils sont FIXES et fournis de l'exterieur, la ou
// une vraie emission les tire au sort : c'est la seule facon d'imprimer dans un
// README un lien qui ouvre vraiment quelque chose. Leur forme est validee au
// demarrage, avec le reste de l'environnement, pour qu'un couple inutilisable
// echoue la ou on peut le comprendre plutot qu'a la premiere tentative du
// client.
export interface DemoAccessLinkSeed {
  readonly token: string;
  readonly pin: string;
}

// Le seul enregistrement dont l'amorcage a besoin : ni la lecture du journal,
// ni le recensement, ni l'expurgation ne le concernent.
export interface DemoActivityEventRecorder {
  record(event: NewActivityEvent): Promise<void>;
}

// La seule ecriture dont l'amorcage a besoin. Le reste du depot de liens —
// verification d'appartenance, revocation, tentatives — ne le concerne pas.
export interface DemoAccessLinkRepository {
  issue_link_replacing_current(input: {
    deposit_request_id: string;
    owner_user_id: string;
    issuance: AccessLinkIssuance;
    now: Date;
  }): Promise<AccessLink | null>;
}

export interface DemoDepositRequestBootstrapOutcome {
  deposit_request_was_created: boolean;
  access_link_was_issued: boolean;
}

export interface DemoDepositRequestBootstrapDependencies {
  deposit_requests: DemoDepositRequestRepository;
  access_links: DemoAccessLinkRepository;
  token_hasher: AccessLinkTokenHasher;
  pin_hasher: PinHasher;
  activity_events: DemoActivityEventRecorder;
  clock: Clock;
}

export async function bootstrap_demo_deposit_request(
  input: { owner_user_id: string; access_link_seed: DemoAccessLinkSeed },
  dependencies: DemoDepositRequestBootstrapDependencies,
): Promise<DemoDepositRequestBootstrapOutcome> {
  // « L'avocat n'a AUCUNE demande », et non « cette demande-ci n'existe pas » :
  // l'amorcage tourne a chaque demarrage, et reconnaitre la demande a son titre
  // la recreerait des que quelqu'un la renomme ou la supprime. Une base vierge
  // est le seul etat ou amorcer ait un sens.
  //
  // Ce garde protege AUSSI le lien : reemettre le lien publie a chaque
  // demarrage remettrait a zero le compteur de tentatives d'une demande bien
  // reelle, et rouvrirait un lien que l'avocat vient peut-etre de revoquer.
  if ((await dependencies.deposit_requests.count_for_owner(input.owner_user_id)) > 0) {
    return { deposit_request_was_created: false, access_link_was_issued: false };
  }

  const deposit_request_id: string = await dependencies.deposit_requests.create({
    owner_user_id: input.owner_user_id,
    creation: DEMO_DEPOSIT_REQUEST,
    // La politique par defaut, celle que le formulaire propose : une demande de
    // demonstration reglee autrement montrerait un produit qui n'existe pas.
    security_policy: DEFAULT_SECURITY_POLICY,
  });

  const access_link_was_issued: boolean = await issue_demo_access_link(
    { deposit_request_id, owner_user_id: input.owner_user_id, seed: input.access_link_seed },
    dependencies,
  );

  return { deposit_request_was_created: true, access_link_was_issued };
}

// L'emission passe deliberement a cote de `AccessLinkIssuanceService` : ce
// service tire lui-meme le jeton et le PIN, ce qui est exactement ce qu'il doit
// faire et exactement ce qu'on ne veut pas ici. Plutot que d'ouvrir le chemin
// d'emission normal a des secrets choisis — une porte qui n'a aucune raison
// d'exister en production —, l'amorcage ecrit lui-meme, avec les MEMES formes
// stockees : empreinte pour le jeton, argon2 pour le PIN.
async function issue_demo_access_link(
  input: { deposit_request_id: string; owner_user_id: string; seed: DemoAccessLinkSeed },
  dependencies: DemoDepositRequestBootstrapDependencies,
): Promise<boolean> {
  const fingerprint: AccessLinkTokenFingerprint = dependencies.token_hasher.fingerprint_token(
    input.seed.token,
  );
  const pin_hash: string = await dependencies.pin_hasher.hash(input.seed.pin);
  const now: Date = dependencies.clock.now();

  const issued: AccessLink | null = await dependencies.access_links.issue_link_replacing_current({
    deposit_request_id: input.deposit_request_id,
    owner_user_id: input.owner_user_id,
    issuance: {
      token_hmac: fingerprint.token_hmac,
      token_pepper_version: fingerprint.token_pepper_version,
      pin_hash,
      security_policy: DEFAULT_SECURITY_POLICY,
      expires_at: new Date(
        now.getTime() + DEFAULT_SECURITY_POLICY.link_lifetime_days * MILLISECONDS_PER_DAY,
      ),
    },
    now,
  });

  if (issued === null) {
    return false;
  }

  // Le meme evenement que pour une emission par l'avocat, et attribue a
  // l'avocat : le tableau de bord de la demande seedee doit raconter la meme
  // histoire que celui d'une demande reelle.
  await dependencies.activity_events.record(
    build_activity_event({
      deposit_request_id: input.deposit_request_id,
      type: 'access_link_issued',
      actor: { kind: 'lawyer', user_id: input.owner_user_id },
      access_link_id: issued.id,
      occurred_at: now,
    }),
  );

  return true;
}
