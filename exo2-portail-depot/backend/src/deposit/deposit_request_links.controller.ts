import type { IncomingMessage } from 'node:http';
import {
  Controller,
  Delete,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { read_authenticated_lawyer_session } from '../auth/route_access.guard';
import type { LawyerSession } from '../auth/lawyer_session_reader';
import {
  ACCESS_LINK_ISSUER,
  type AccessLinkDelivery,
  type AccessLinkIssuer,
} from '../access_link/access_link_issuer';
import {
  ACCESS_LINK_REPOSITORY,
  type AccessLinkRepository,
} from '../access_link/access_link_repository';
import { CLOCK, type Clock } from '../shared/clock';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestDetail,
  type DepositRequestRepository,
} from './deposit_request_repository';

// Aucun decorateur d'acces : le defaut est 'lawyer'. Ces deux routes rendent le
// couple lien + PIN en clair, ou le detruisent — ce sont les plus sensibles du
// cote avocat.
@Controller('requests/:deposit_request_id/links')
export class DepositRequestLinksController {
  constructor(
    @Inject(ACCESS_LINK_ISSUER) private readonly access_link_issuer: AccessLinkIssuer,
    @Inject(ACCESS_LINK_REPOSITORY) private readonly access_links: AccessLinkRepository,
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DepositRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Regenerer, c'est invalider : l'ancien couple ne rouvre plus rien des cet
  // instant, et le message est rendu une fois — une seule.
  @Post()
  @HttpCode(201)
  async regenerate_access_link(
    @Req() request: IncomingMessage,
    @Param('deposit_request_id') deposit_request_id: string,
  ): Promise<AccessLinkDelivery> {
    const owner_user_id: string = read_lawyer_session(request).user_id;

    // La politique est relue sur la DEMANDE a chaque emission : c'est la
    // derniere reglee par l'avocat qui vaut pour le nouveau lien, tandis que
    // celle du lien precedent reste figee sur lui.
    const detail: DepositRequestDetail | null =
      await this.deposit_requests.find_detail_for_owner(deposit_request_id, owner_user_id);

    if (detail === null) {
      throw new NotFoundException();
    }

    const delivery: AccessLinkDelivery | null =
      await this.access_link_issuer.issue_for_deposit_request({
        deposit_request_id,
        owner_user_id,
        deposit_request_title: detail.title,
        security_policy: detail.security_policy,
      });

    if (delivery === null) {
      throw new NotFoundException();
    }

    return delivery;
  }

  // 204 : il n'y a rien a rendre, et surtout rien a redire du lien detruit.
  @Delete('current')
  @HttpCode(204)
  async revoke_current_access_link(
    @Req() request: IncomingMessage,
    @Param('deposit_request_id') deposit_request_id: string,
  ): Promise<void> {
    const revoked: boolean = await this.access_links.revoke_current_link(
      deposit_request_id,
      read_lawyer_session(request).user_id,
      this.clock.now(),
    );

    // 404 et jamais 403, comme partout ailleurs : « pas a vous » et « il n'y a
    // plus de lien courant » se repondent de la meme facon, sinon l'identifiant
    // d'une demande d'un confrere devient un oracle.
    if (!revoked) {
      throw new NotFoundException();
    }
  }
}

// Le garde a deja refuse la requete si la session manquait : arriver ici sans
// session serait un garde debranche, pas une requete anonyme.
function read_lawyer_session(request: IncomingMessage): LawyerSession {
  const session: LawyerSession | null = read_authenticated_lawyer_session(request);
  if (session === null) {
    throw new NotFoundException();
  }
  return session;
}
