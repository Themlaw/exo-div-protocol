import type { IncomingMessage } from 'node:http';
import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalRoute } from '../auth/route_access';
import {
  INTERNAL_STORAGE_EVENTS_PATH,
  INTERNAL_STORAGE_WEBHOOK_HEADER_NAME,
} from '../auth/auth_http_contract';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { matches_internal_storage_webhook_secret } from './internal_storage_webhook_secret';

// 'internal' et non 'client_link' : cette route n'est pas ouverte, elle est
// authentifiee autrement — par un secret partage avec MinIO. Les confondre
// ferait qu'un oubli de decorateur sur l'une ouvrirait l'autre.
@Controller()
@InternalRoute()
export class InternalStorageEventsController {
  constructor(
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
  ) {}

  // 202 et non 200 : la notification est acceptee, le traitement du scan viendra
  // plus tard et hors de cette requete. MinIO reessaie sur echec, il ne doit pas
  // attendre notre travail.
  @Post(INTERNAL_STORAGE_EVENTS_PATH)
  @HttpCode(202)
  accept_storage_event(@Req() request: IncomingMessage): { status: string } {
    const presented_secret: string | string[] | undefined =
      request.headers[INTERNAL_STORAGE_WEBHOOK_HEADER_NAME];

    if (
      typeof presented_secret === 'string' &&
      matches_internal_storage_webhook_secret(
        presented_secret,
        this.environment.internal_storage_webhook_secret,
      )
    ) {
      return { status: 'accepted' };
    }

    throw new UnauthorizedException();
  }
}
