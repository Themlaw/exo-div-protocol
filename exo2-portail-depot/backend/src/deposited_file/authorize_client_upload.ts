import { randomUUID } from 'node:crypto';
import type { Clock } from '../shared/clock';
import type { AccessLink } from '../domain/access_link';
import type { DepositSession } from '../domain/deposit_session';
import type { ExpectedDocument } from '../domain/expected_document';
import {
  build_deposit_object_key,
  build_presigned_upload_policy,
  compute_presigned_upload_expiry,
  sanitize_client_filename_for_display,
  type PresignedUploadPolicy,
} from '../domain/presigned_upload';
import {
  QUARANTINE_BUCKET_NAME,
  type ObjectStorage,
  type PresignedUploadTicket,
} from '../object_storage/object_storage';
import type { DepositSessionRepository } from '../deposit_session/deposit_session_repository';
import type { ClientDepositRequestView, DepositRequestRepository } from '../deposit/deposit_request_repository';
import {
  ExpectedDocumentAlreadyOccupiedError,
  type DepositedFileRepository,
} from './deposited_file_repository';

export const CLIENT_UPLOAD_AUTHORIZER: unique symbol = Symbol('CLIENT_UPLOAD_AUTHORIZER');

// Trente autorisations par session, la session durant trente minutes et une
// demande depassant rarement dix pieces. La marge couvre les reprises apres
// echec reseau sans offrir a un porteur de lien un generateur illimite d'URL
// d'ecriture — chaque autorisation etant un droit d'ecrire dans notre bucket.
export const MAXIMUM_UPLOADS_PER_DEPOSIT_SESSION = 30;

// Dix minutes : le temps d'envoyer vingt megaoctets sur une connexion mediocre,
// sans qu'une autorisation trainante reste valable une fois l'onglet ferme.
// Bornee de toute facon par la session, elle-meme bornee par le lien.
export const PRESIGNED_UPLOAD_LIFETIME_SECONDS = 10 * 60;

export type ClientUploadAuthorizationOutcome =
  | { kind: 'authorized'; deposited_file_id: string; ticket: PresignedUploadTicket }
  | { kind: 'unknown_expected_document' }
  | { kind: 'expected_document_already_occupied' }
  | { kind: 'declared_mime_type_not_allowed'; allowed_mime_types: readonly string[] }
  | { kind: 'declared_size_above_limit'; max_size_bytes: number }
  | { kind: 'upload_allowance_exhausted' };

export interface ClientUploadRequest {
  session: DepositSession;
  access_link: AccessLink;
  expected_document_id: string;
  filename: string;
  declared_mime_type: string;
  declared_size_bytes: number;
}

export interface ClientUploadAuthorizer {
  authorize(request: ClientUploadRequest): Promise<ClientUploadAuthorizationOutcome>;
}

export interface ClientUploadAuthorizationDependencies {
  deposit_requests: DepositRequestRepository;
  deposited_files: DepositedFileRepository;
  deposit_sessions: DepositSessionRepository;
  object_storage: ObjectStorage;
  clock: Clock;
}

export class ClientUploadAuthorizationService implements ClientUploadAuthorizer {
  constructor(private readonly dependencies: ClientUploadAuthorizationDependencies) {}

  async authorize(request: ClientUploadRequest): Promise<ClientUploadAuthorizationOutcome> {
    // L'emplacement doit appartenir a la demande que CE lien ouvre. Sans ce
    // rapprochement, un client legitime deposerait dans le dossier d'un autre
    // en changeant un identifiant dans le corps de sa requete.
    const expected_document: ExpectedDocument | null = await this.find_expected_document_of_link(
      request.access_link,
      request.expected_document_id,
    );
    if (expected_document === null) {
      return { kind: 'unknown_expected_document' };
    }

    // UN document attendu, UNE piece : le remplacement passe par un retrait
    // explicite. Delivrer quand meme une autorisation ferait deposer un objet
    // que le webhook refuserait ensuite d'attacher, et le client verrait son
    // envoi reussir sans que rien n'apparaisse.
    if (
      (await this.dependencies.deposited_files.find_occupant_of_expected_document(
        expected_document.id,
      )) !== null
    ) {
      return { kind: 'expected_document_already_occupied' };
    }

    // Le type ANNONCE est refuse tot par courtoisie : le client apprend son
    // erreur avant d'envoyer vingt megaoctets. Ce n'est pas la vraie barriere —
    // seul le type detecte fait foi, et il ne sera connu qu'apres l'arrivee.
    if (!expected_document.allowed_mime_types.includes(request.declared_mime_type)) {
      return {
        kind: 'declared_mime_type_not_allowed',
        allowed_mime_types: expected_document.allowed_mime_types,
      };
    }

    // Meme role : la borne reelle est dans la policy, que MinIO applique quoi
    // que le client annonce.
    if (request.declared_size_bytes > expected_document.max_size_bytes) {
      return { kind: 'declared_size_above_limit', max_size_bytes: expected_document.max_size_bytes };
    }

    // Le quota est consomme AVANT la signature : le decompter apres laisserait
    // une signature delivree sans etre comptee des qu'une erreur survient
    // entre les deux.
    const allowance_was_available: boolean =
      await this.dependencies.deposit_sessions.consume_upload_allowance(
        request.session.id,
        MAXIMUM_UPLOADS_PER_DEPOSIT_SESSION,
      );
    if (!allowance_was_available) {
      return { kind: 'upload_allowance_exhausted' };
    }

    const now: Date = this.dependencies.clock.now();
    // Tire par nous, et non lu sur la ligne : la cle de l'objet doit exister
    // avant l'insertion, et faire ecrire la ligne pour lire son identifiant
    // imposerait une seconde ecriture.
    const upload_id: string = randomUUID();
    const object_key: string = build_deposit_object_key({
      deposit_request_id: expected_document.deposit_request_id,
      expected_document_id: expected_document.id,
      upload_id,
    });

    try {
      const reserved = await this.dependencies.deposited_files.reserve_upload_slot({
        expected_document_id: expected_document.id,
        access_link_id: request.access_link.id,
        object_key,
        display_filename: sanitize_client_filename_for_display(request.filename),
        declared_mime_type: request.declared_mime_type,
        detected_mime_type: null,
        declared_size_bytes: request.declared_size_bytes,
        actual_size_bytes: null,
        status: 'pending_upload',
        created_at: now,
        uploaded_at: null,
        scanned_at: null,
      });

      const policy: PresignedUploadPolicy = build_presigned_upload_policy({
        bucket: QUARANTINE_BUCKET_NAME,
        object_key,
        max_size_bytes: expected_document.max_size_bytes,
        expires_at: compute_presigned_upload_expiry(
          request.session,
          PRESIGNED_UPLOAD_LIFETIME_SECONDS,
          now,
        ),
      });

      return {
        kind: 'authorized',
        deposited_file_id: reserved.id,
        ticket: await this.dependencies.object_storage.create_presigned_upload(
          policy,
          request.declared_mime_type,
        ),
      };
    } catch (error: unknown) {
      if (error instanceof ExpectedDocumentAlreadyOccupiedError) {
        return { kind: 'expected_document_already_occupied' };
      }
      throw error;
    }
  }

  private async find_expected_document_of_link(
    access_link: AccessLink,
    expected_document_id: string,
  ): Promise<ExpectedDocument | null> {
    const view: ClientDepositRequestView | null =
      await this.dependencies.deposit_requests.find_client_view(access_link.deposit_request_id);

    return (
      view?.expected_documents.find(
        (document: ExpectedDocument): boolean => document.id === expected_document_id,
      ) ?? null
    );
  }
}
