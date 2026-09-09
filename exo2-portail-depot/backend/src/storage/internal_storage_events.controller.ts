import type { IncomingMessage } from 'node:http';
import {
  Body,
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
import {
  OBJECT_ARRIVAL_RECORDER,
  type ObjectArrivalRecorder,
} from '../scan/record_object_arrival';
import {
  read_object_arrival_notifications,
  type ObjectArrivalNotification,
} from '../scan/storage_event';

// 'internal' et non 'client_link' : cette route n'est pas ouverte, elle est
// authentifiee autrement — par un secret partage avec MinIO. Les confondre
// ferait qu'un oubli de decorateur sur l'une ouvrirait l'autre.
@Controller()
@InternalRoute()
export class InternalStorageEventsController {
  constructor(
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
    @Inject(OBJECT_ARRIVAL_RECORDER) private readonly arrivals: ObjectArrivalRecorder,
  ) {}

  // 202 et non 200 : la notification est acceptee, le traitement du scan viendra
  // plus tard et hors de cette requete. MinIO reessaie sur echec, il ne doit pas
  // attendre notre travail.
  @Post(INTERNAL_STORAGE_EVENTS_PATH)
  @HttpCode(202)
  async accept_storage_event(
    @Req() request: IncomingMessage,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const presented_secret: string | string[] | undefined =
      request.headers[INTERNAL_STORAGE_WEBHOOK_HEADER_NAME];

    if (
      typeof presented_secret !== 'string' ||
      !matches_internal_storage_webhook_secret(
        presented_secret,
        this.environment.internal_storage_webhook_secret,
      )
    ) {
      throw new UnauthorizedException();
    }

    const arrivals: readonly ObjectArrivalNotification[] =
      read_object_arrival_notifications(body);

    // En SERIE et non en parallele : deux arrivees pour le meme emplacement
    // doivent se departager par l'index, ce que des ecritures concurrentes
    // rendraient inutilement dependant du hasard. Un lot de notifications reste
    // minuscule.
    for (const arrival of arrivals) {
      await this.arrivals.record(arrival);
    }

    return { status: 'accepted' };
  }
}
