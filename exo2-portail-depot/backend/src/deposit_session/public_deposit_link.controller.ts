import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  Res,
} from '@nestjs/common';
import { ClientLinkRoute, ClientSessionRoute } from '../auth/route_access';
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
  session_expires_at: string;
  expected_documents: readonly ClientExpectedDocumentView[];
}

interface ClientExpectedDocumentView {
  id: string;
  label: string;
  position: number;
  allowed_mime_types: readonly string[];
  max_size_bytes: number;
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
    @Inject(ACCESS_LINK_TOKEN_HASHER) private readonly token_hasher: AccessLinkTokenHasher,
    @Inject(DEPOSIT_LINK_UNLOCKER) private readonly unlocker: DepositLinkUnlocker,
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

    return {
      title: view.title,
      session_expires_at: opened_session.session.expires_at.toISOString(),
      expected_documents: view.expected_documents.map(
        (document: ExpectedDocument): ClientExpectedDocumentView => ({
          id: document.id,
          label: document.label,
          position: document.position,
          allowed_mime_types: document.allowed_mime_types,
          max_size_bytes: document.max_size_bytes,
        }),
      ),
    };
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
