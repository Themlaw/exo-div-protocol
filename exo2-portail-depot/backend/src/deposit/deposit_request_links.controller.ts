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
import { require_lawyer_session } from '../auth/require_lawyer_session';
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
  ACTIVITY_EVENT_REPOSITORY,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import { build_activity_event } from '../domain/activity_event';
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
    @Inject(ACTIVITY_EVENT_REPOSITORY)
    private readonly activity_events: ActivityEventRepository,
  ) {}

  // Regenerer, c'est invalider : l'ancien couple ne rouvre plus rien des cet
  // instant, et le message est rendu une fois — une seule.
  @Post()
  @HttpCode(201)
  async regenerate_access_link(
    @Req() request: IncomingMessage,
    @Param('deposit_request_id') deposit_request_id: string,
  ): Promise<AccessLinkDelivery> {
    const owner_user_id: string = require_lawyer_session(request).user_id;

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
    const owner_user_id: string = require_lawyer_session(request).user_id;
    const now: Date = this.clock.now();
    const revoked_access_link_id: string | null = await this.access_links.revoke_current_link(
      deposit_request_id,
      owner_user_id,
      now,
    );

    // 404 et jamais 403, comme partout ailleurs : « pas a vous » et « il n'y a
    // plus de lien courant » se repondent de la meme facon, sinon l'identifiant
    // d'une demande d'un confrere devient un oracle.
    if (revoked_access_link_id === null) {
      throw new NotFoundException();
    }

    // Journalise APRES la revocation : un evenement ecrit avant annoncerait une
    // destruction qui n'a peut-etre pas eu lieu.
    await this.activity_events.record(
      build_activity_event({
        deposit_request_id,
        type: 'access_link_revoked',
        actor: { kind: 'lawyer', user_id: owner_user_id },
        access_link_id: revoked_access_link_id,
        occurred_at: now,
      }),
    );
  }
}
