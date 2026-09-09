import type { IncomingMessage } from 'node:http';
import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { require_lawyer_session } from '../auth/require_lawyer_session';
import {
  ACTIVITY_EVENT_REPOSITORY,
  ACTIVITY_PAGE_SIZE,
  type ActivityEventRepository,
} from '../activity/activity_event_repository';
import {
  to_lawyer_activity_event_view,
  type ActivityEvent,
  type LawyerActivityEventView,
} from '../domain/activity_event';
import {
  DEPOSIT_REQUEST_REPOSITORY,
  type DepositRequestRepository,
} from './deposit_request_repository';

export interface LawyerActivityPage {
  events: LawyerActivityEventView[];
  // Dit au front qu'il ne voit pas tout, sans lui donner de quoi paginer : le
  // curseur viendra le jour ou un ecran en aura reellement besoin, et son
  // absence aujourd'hui ne casse pas ce contrat-ci.
  has_more: boolean;
}

// Aucun decorateur d'acces : le defaut est 'lawyer'. Le journal est la memoire
// du dossier, et il ne se lit que de ce cote-la.
@Controller('requests/:deposit_request_id/activity')
export class DepositRequestActivityController {
  constructor(
    @Inject(DEPOSIT_REQUEST_REPOSITORY)
    private readonly deposit_requests: DepositRequestRepository,
    @Inject(ACTIVITY_EVENT_REPOSITORY)
    private readonly activity_events: ActivityEventRepository,
  ) {}

  @Get()
  async read_deposit_request_activity(
    @Req() request: IncomingMessage,
    @Param('deposit_request_id') deposit_request_id: string,
  ): Promise<LawyerActivityPage> {
    const owner_user_id: string = require_lawyer_session(request).user_id;

    // L'appartenance AVANT toute lecture du journal : sans elle, un identifiant
    // de demande suffirait a lire l'activite du dossier d'un confrere. Et le
    // refus est un 404, le meme que pour une demande inexistante.
    if (!(await this.deposit_requests.belongs_to_owner(deposit_request_id, owner_user_id))) {
      throw new NotFoundException();
    }

    // Un evenement de plus que la page : c'est ce surnumeraire, jamais rendu,
    // qui dit qu'il y a une suite — sans avoir a compter la table entiere.
    const events: ActivityEvent[] = await this.activity_events.list_for_deposit_request(
      deposit_request_id,
      ACTIVITY_PAGE_SIZE + 1,
    );

    return {
      events: events.slice(0, ACTIVITY_PAGE_SIZE).map(to_lawyer_activity_event_view),
      has_more: events.length > ACTIVITY_PAGE_SIZE,
    };
  }
}
