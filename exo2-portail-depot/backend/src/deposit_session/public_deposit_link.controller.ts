import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  BadRequestException,
  ConflictException,
  Delete,
  HttpException,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  Res,
} from '@nestjs/common';
import { ClientLinkRoute, ClientSessionRoute } from '../auth/route_access';
import { RoutedNotFoundException } from '../auth/unrouted_request.filter';
import {
  DEPOSIT_SESSION_COOKIE_NAME,
  PUBLIC_DEPOSIT_PATH,
} from '../auth/auth_http_contract';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { CLOCK, type Clock } from '../shared/clock';
import { resolve_trusted_client_ip } from '../auth/login_throttling';
import { read_forwarded_for_chain } from '../auth/throttle_lawyer_login';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../access_link/access_link_repository';
import {
  ACCESS_LINK_TOKEN_HASHER,
  type AccessLinkTokenHasher,
} from '../access_link/access_link_token_hasher';
import { resolve_public_access_link_state, type PublicAccessLinkState } from '../domain/access_link';
import {
  CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS,
  DEPOSIT_LINK_UNLOCKER,
  type DepositLinkUnlockOutcome,
  type DepositLinkUnlocker,
} from './unlock_deposit_link';
import { CLIENT_PIN_IP_RATE_LIMIT_BOUNDS } from './client_pin_throttle_store';
import { read_authenticated_deposit_session } from './client_deposit_session.guard';
import type { OpenedDepositSession } from './deposit_session_repository';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type ClientDepositRequestView,
  type DepositRequestRepository,
} from '../deposit/deposit_request_repository';
import type { ExpectedDocument } from '../domain/expected_document';
import {
  CLIENT_FILE_REMOVER,
  type ClientFileRemovalOutcome,
  type ClientFileRemover,
} from '../deposited_file/remove_client_file';
import {
  DEPOSITED_FILE_REPOSITORY,
  type DepositedFileRepository,
} from '../deposited_file/deposited_file_repository';
import type { DepositedFile } from '../domain/deposited_file';
import { does_deposited_file_occupy_expected_document } from '../domain/deposited_file';
import type { DepositRequestStatus } from '../domain/deposit_request_status';
import {
  DEPOSIT_REQUEST_LIFECYCLE,
  type DepositRequestLifecycle,
} from '../deposit/deposit_request_lifecycle';
import { ForbiddenDepositRequestTransitionError } from '../domain/deposit_request_status';
import {
  CLIENT_UPLOAD_AUTHORIZER,
  type ClientUploadAuthorizationOutcome,
  type ClientUploadAuthorizer,
} from '../deposited_file/authorize_client_upload';

// Ce que le client anonyme a le droit de savoir AVANT le PIN : l'etat, et la
// longueur du code pour dessiner la saisie. Ni titre, ni nombre de pieces, ni
// nom de dossier — la longueur, elle, est deja sous les yeux du destinataire
// legitime dans le message qu'il a recu.
interface PublicAccessLinkView {
  state: PublicAccessLinkState;
  pin_length?: number;
}

// Le corps du refus, IDENTIQUE pour toutes les causes : token inconnu, lien
// expire, lien revoque, PIN faux, PIN de mauvaise longueur. Distinguer
// reviendrait a repondre « ce token existe » a qui en essaie au hasard.
const GENERIC_REFUSAL_BODY = { state: 'invalid' } as const;

// Ce que le client voit une fois le PIN passe. Le titre apparait ICI et pas
// avant : sur la page d'accueil du lien il serait une fuite, derriere le PIN il
// est ce qui permet de savoir quel dossier on ouvre.
interface ClientDepositBoardView {
  title: string;
  deposit_request_status: DepositRequestStatus;
  session_expires_at: string;
  expected_documents: readonly ClientExpectedDocumentView[];
}

// Ce que le navigateur poste ensuite, tel quel, vers MinIO.
interface ClientUploadTicketView {
  deposited_file_id: string;
  upload_url: string;
  form_fields: Readonly<Record<string, string>>;
  expires_at: string;
}

interface ClientExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: readonly string[];
  max_size_bytes: number;
  // `null` tant que l'emplacement est libre. Seule la piece qui l'OCCUPE est
  // rendue : une reservation dont l'objet n'est jamais arrive ne doit pas
  // s'afficher comme un depot reussi.
  deposited_file: ClientDepositedFileView | null;
}

interface ClientDepositedFileView {
  id: string;
  display_filename: string;
  status: string;
}

// L'acces est declare PAR METHODE et non sur la classe : ce controleur porte
// deux surfaces qui n'ont rien a voir — deux routes anonymes, ou le jeton et le
// PIN decident, et une route adossee a une session ouverte. Un acces de classe
// aurait rendu l'une des deux fausse, quelle qu'elle soit.
@Controller('public')
export class PublicDepositLinkController {
  constructor(
    @Inject(ACCESS_LINK_REPOSITORY) private readonly access_links: AccessLinkRepository,
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DepositRequestRepository,
    @Inject(CLIENT_UPLOAD_AUTHORIZER) private readonly upload_authorizer: ClientUploadAuthorizer,
    @Inject(CLIENT_FILE_REMOVER) private readonly file_remover: ClientFileRemover,
    @Inject(DEPOSITED_FILE_REPOSITORY)
    private readonly deposited_files: DepositedFileRepository,
    @Inject(ACCESS_LINK_TOKEN_HASHER) private readonly token_hasher: AccessLinkTokenHasher,
    @Inject(DEPOSIT_LINK_UNLOCKER) private readonly unlocker: DepositLinkUnlocker,
    @Inject(DEPOSIT_REQUEST_LIFECYCLE)
    private readonly deposit_request_lifecycle: DepositRequestLifecycle,
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get(':token')
  @ClientLinkRoute()
  async read_public_link_state(@Param('token') token: string): Promise<PublicAccessLinkView> {
    const { token_hmac } = this.token_hasher.fingerprint_token(token);
    const link = await this.access_links.find_by_token_hmac(token_hmac);
    const state: PublicAccessLinkState = resolve_public_access_link_state(
      link,
      this.clock.now(),
    );

    // La longueur n'accompagne que l'etat actif : sur un lien mort, la donner
    // dirait que le token a existe.
    return state === 'active' && link !== null
      ? { state, pin_length: link.pin_length }
      : { state };
  }

  // Le jeton de l'URL n'est PAS relu ici : le garde a deja verifie que la
  // session presentee est bien celle de ce lien-la. Le refaire ouvrirait la
  // porte a deux verdicts divergents.
  @Get(':token/documents')
  @ClientSessionRoute()
  async list_documents_to_deposit(@Req() request: IncomingMessage): Promise<ClientDepositBoardView> {
    // Le garde a depose la session ici. La relire nullable plutot que
    // l'affirmer : un `as` mentirait au compilateur le jour ou quelqu'un
    // retirerait le decorateur d'acces, et la route rendrait un 500 au lieu
    // d'un refus.
    const opened_session: OpenedDepositSession | null =
      read_authenticated_deposit_session(request);
    if (opened_session === null) {
      throw new UnauthorizedException();
    }

    const view: ClientDepositRequestView | null = await this.deposit_requests.find_client_view(
      opened_session.access_link.deposit_request_id,
    );

    // Une session valide dont la demande a disparu ne peut pas exister : la
    // cle etrangere du lien vers la demande l'interdit. Refuser plutot que
    // supposer, sans distinguer ce cas des autres refus.
    if (view === null) {
      throw new UnauthorizedException();
    }

    const occupants: Map<string, DepositedFile> = index_occupants_by_expected_document(
      await this.deposited_files.list_for_deposit_request(
        opened_session.access_link.deposit_request_id,
      ),
    );

    return {
      title: view.title,
      deposit_request_status: view.status,
      session_expires_at: opened_session.session.expires_at.toISOString(),
      expected_documents: view.expected_documents.map(
        (document: ExpectedDocument): ClientExpectedDocumentView => ({
          id: document.id,
          label: document.label,
          position: document.position,
          allowed_mime_types: document.allowed_mime_types,
          max_size_bytes: document.max_size_bytes,
          deposited_file: render_deposited_file(occupants.get(document.id)),
        }),
      ),
    };
  }

  // Le retrait est explicite, jamais implicite dans un nouvel envoi : c'est ce
  // qui garantit qu'un emplacement ne porte a aucun instant deux objets, et que
  // l'ancien quitte reellement le bucket.
  @Delete(':token/files/:deposited_file_id')
  @ClientSessionRoute()
  @HttpCode(204)
  async remove_deposited_file(
    @Req() request: IncomingMessage,
    @Param('deposited_file_id') deposited_file_id: string,
  ): Promise<void> {
    const opened_session: OpenedDepositSession | null =
      read_authenticated_deposit_session(request);
    if (opened_session === null) {
      throw new UnauthorizedException();
    }

    const outcome: ClientFileRemovalOutcome = await this.file_remover.remove({
      access_link: opened_session.access_link,
      deposited_file_id,
    });

    if (outcome.kind === 'unknown_file') {
      throw new RoutedNotFoundException({ message: 'Cette piece est introuvable' });
    }

    // 409 : la demande est partie en traitement, elle appartient desormais au
    // dossier de l'avocat. Retirer une piece changerait sous ses yeux ce qu'il
    // est en train d'examiner.
    if (outcome.kind === 'deposit_request_is_frozen') {
      throw new ConflictException(
        "Cette demande est en cours de traitement : les pieces ne peuvent plus etre retirees",
      );
    }
  }

  // Delivre une autorisation d'ecrire dans le bucket, jamais les octets : ils
  // vont du navigateur a MinIO sans passer par l'API. C'est ce qui rend la
  // barre de progression honnete et evite de faire transiter vingt megaoctets
  // par un processus qui n'a rien a en faire.
  @Post(':token/uploads')
  @ClientSessionRoute()
  @HttpCode(201)
  async authorize_document_upload(
    @Req() request: IncomingMessage,
    @Body() body: unknown,
  ): Promise<ClientUploadTicketView> {
    const opened_session: OpenedDepositSession | null =
      read_authenticated_deposit_session(request);
    if (opened_session === null) {
      throw new UnauthorizedException();
    }

    const submitted = read_upload_request_body(body);
    const outcome: ClientUploadAuthorizationOutcome = await this.upload_authorizer.authorize({
      session: opened_session.session,
      access_link: opened_session.access_link,
      expected_document_id: submitted.expected_document_id,
      filename: submitted.filename,
      declared_mime_type: submitted.declared_mime_type,
      declared_size_bytes: submitted.declared_size_bytes,
    });

    return render_upload_outcome(outcome);
  }

  // Le SEUL geste qui fait quitter `incomplete` a une demande, et il est
  // explicite : basculer au dernier envoi bloquerait le client qui voulait
  // encore remplacer une piece par une transition qu'il n'a pas demandee.
  // A partir de la, les pieces sont gelees — c'est le dossier de l'avocat.
  @Post(':token/completion')
  @ClientSessionRoute()
  @HttpCode(200)
  async complete_deposit(@Req() request: IncomingMessage): Promise<{ status: DepositRequestStatus }> {
    const opened_session: OpenedDepositSession | null =
      read_authenticated_deposit_session(request);
    if (opened_session === null) {
      throw new UnauthorizedException();
    }

    try {
      const status: DepositRequestStatus | null =
        await this.deposit_request_lifecycle.apply_client_action({
          deposit_request_id: opened_session.access_link.deposit_request_id,
          access_link_id: opened_session.access_link.id,
          action: 'client_finished_deposit',
        });

      if (status === null) {
        throw new RoutedNotFoundException({ message: 'Cette demande est introuvable' });
      }

      return { status };
    } catch (failure: unknown) {
      // 409 plutot que 500 : terminer deux fois, ou terminer sur un lien
      // bloque, n'est pas une panne — c'est une interface qui a propose une
      // action qu'elle n'aurait pas du proposer, et le client doit le lire.
      if (failure instanceof ForbiddenDepositRequestTransitionError) {
        throw new ConflictException("Ce depot ne peut plus etre termine");
      }
      throw failure;
    }
  }

  @Post(':token/unlock')
  @ClientLinkRoute()
  @HttpCode(200)
  async unlock_deposit_link(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const outcome: DepositLinkUnlockOutcome = await this.unlocker.unlock({
      token,
      submitted_pin: read_submitted_pin(body),
      client_ip: resolve_trusted_client_ip(
        read_forwarded_for_chain(request.headers),
        request.socket.remoteAddress ?? '',
        this.environment.trusted_proxy_hop_count,
      ),
    });

    if (outcome.kind === 'rate_limited') {
      // Le seul refus qui s'explique, parce qu'il ne dit rien du lien : il
      // parle de l'adresse qui appelle, et le client legitime a besoin de
      // savoir qu'il doit patienter plutot que redemander un lien.
      response.setHeader('retry-after', CLIENT_PIN_IP_RATE_LIMIT_BOUNDS.window_seconds);
      write_json(response, 429, { state: 'rate_limited' });
      return;
    }

    if (outcome.kind === 'blocked') {
      write_json(response, 403, { state: 'blocked' });
      return;
    }

    if (outcome.kind === 'refused') {
      write_json(response, 401, GENERIC_REFUSAL_BODY);
      return;
    }

    response.setHeader(
      'set-cookie',
      build_deposit_session_cookie(outcome.session_token),
    );
    write_json(response, 200, { expires_at: outcome.expires_at.toISOString() });
  }
}

// Un corps illisible est un refus comme un autre, jamais une erreur 400 : une
// erreur de forme distinguerait « ce token existe, mais ta requete est mal
// faite » de « ce token n'existe pas ».
// Derriere la session, le client est legitime : un corps mal forme merite une
// erreur qui le dit. C'est l'inverse exact du deverrouillage, ou toute
// distinction serait un oracle.
function index_occupants_by_expected_document(
  files: readonly DepositedFile[],
): Map<string, DepositedFile> {
  return new Map(
    files
      .filter(does_deposited_file_occupy_expected_document)
      .map((file: DepositedFile): [string, DepositedFile] => [file.expected_document_id, file]),
  );
}

function render_deposited_file(file: DepositedFile | undefined): ClientDepositedFileView | null {
  return file === undefined
    ? null
    : { id: file.id, display_filename: file.display_filename, status: file.status };
}

function read_upload_request_body(body: unknown): {
  expected_document_id: string;
  filename: string;
  declared_mime_type: string;
  declared_size_bytes: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Corps de requete attendu');
  }

  const { expected_document_id, filename, mime_type, size_bytes } = body as Record<string, unknown>;

  if (
    typeof expected_document_id !== 'string' ||
    typeof filename !== 'string' ||
    typeof mime_type !== 'string' ||
    typeof size_bytes !== 'number' ||
    !Number.isSafeInteger(size_bytes) ||
    size_bytes <= 0
  ) {
    throw new BadRequestException(
      'expected_document_id, filename, mime_type et size_bytes sont requis',
    );
  }

  return {
    expected_document_id,
    filename,
    declared_mime_type: mime_type,
    declared_size_bytes: size_bytes,
  };
}

function render_upload_outcome(
  outcome: ClientUploadAuthorizationOutcome,
): ClientUploadTicketView {
  switch (outcome.kind) {
    case 'authorized':
      return {
        deposited_file_id: outcome.deposited_file_id,
        upload_url: outcome.ticket.upload_url,
        form_fields: outcome.ticket.form_fields,
        expires_at: outcome.ticket.expires_at.toISOString(),
      };
    case 'unknown_expected_document':
      throw new RoutedNotFoundException({
        message: "Cet emplacement n'appartient pas a cette demande",
      });
    // 409 et non 400 : la requete est valide, c'est l'etat qui s'y oppose, et le
    // client sait quoi faire — retirer la piece en place puis recommencer.
    case 'expected_document_already_occupied':
      throw new ConflictException(
        "Une piece occupe deja cet emplacement : retirez-la avant d'en deposer une autre",
      );
    case 'declared_mime_type_not_allowed':
      throw new UnprocessableEntityException({
        reason: 'mime_type_not_allowed',
        allowed_mime_types: outcome.allowed_mime_types,
      });
    case 'declared_size_above_limit':
      throw new UnprocessableEntityException({
        reason: 'declared_size_above_limit',
        max_size_bytes: outcome.max_size_bytes,
      });
    case 'upload_allowance_exhausted':
      throw new HttpException(
        "Trop d'envois pour cette session : rouvrez le lien avec votre code",
        429,
      );
  }
}

function read_submitted_pin(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }
  const submitted_pin: unknown = (body as Record<string, unknown>).pin;
  return typeof submitted_pin === 'string' ? submitted_pin : '';
}

function build_deposit_session_cookie(session_token: string): string {
  return [
    `${DEPOSIT_SESSION_COOKIE_NAME}=${session_token}`,
    // Confine a la surface anonyme : ce cookie n'a rien a faire sur une route
    // avocat, ni sur les assets du front.
    `Path=${PUBLIC_DEPOSIT_PATH}`,
    `Max-Age=${CLIENT_DEPOSIT_SESSION_LIFETIME_SECONDS}`,
    // Aucun JavaScript ne le lit : une XSS sur la page de depot ne l'exfiltre
    // pas.
    'HttpOnly',
    // Bloque le POST inter-site : sans lui, une page piegee declencherait un
    // depot ou une suppression au nom d'un client deja deverrouille.
    'SameSite=Lax',
    // Toujours, y compris en developpement : les navigateurs acceptent un
    // cookie `Secure` sur http://localhost, et un cookie de session qui
    // transite en clair une seule fois est un cookie perdu.
    'Secure',
  ].join('; ');
}

function write_json(response: ServerResponse, status_code: number, body: unknown): void {
  response.statusCode = status_code;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
