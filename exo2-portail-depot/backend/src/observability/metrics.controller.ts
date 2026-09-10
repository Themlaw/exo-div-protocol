import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Inject, Req, Res, UnauthorizedException } from '@nestjs/common';
import { InternalRoute } from '../auth/route_access';
import {
  INTERNAL_METRICS_SCRAPE_HEADER_NAME,
  METRICS_PATH,
} from '../auth/auth_http_contract';
import {
  matches_internal_shared_secret,
  read_presented_shared_secret,
} from '../auth/internal_shared_secret';
import { APPLICATION_ENVIRONMENT } from '../config/configuration.module';
import type { ApplicationEnvironment } from '../config/environment';
import { METRICS_REGISTRY, type MetricsRegistry, type RenderedMetrics } from './metrics';

// 'internal' et non 'health' : une sonde de vie ne dit rien, une page de
// metriques dit combien de dossiers existent, a quelle cadence on echoue a
// deverrouiller un lien et quand le service a redemarre. C'est une surface de
// reconnaissance, et elle se presente donc avec le secret partage.
@Controller()
@InternalRoute()
export class MetricsController {
  constructor(
    @Inject(APPLICATION_ENVIRONMENT) private readonly environment: ApplicationEnvironment,
    @Inject(METRICS_REGISTRY) private readonly metrics: MetricsRegistry,
  ) {}

  @Get(METRICS_PATH)
  async read_metrics(
    @Req() request: IncomingMessage,
    // `passthrough` : Nest continue d'ecrire le corps rendu ici, et l'acces a
    // la reponse ne sert qu'a poser le type de contenu, que seul le registre
    // connait — la version du format d'exposition en fait partie.
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<string> {
    const presented_secret: string | null = read_presented_shared_secret(
      request.headers[INTERNAL_METRICS_SCRAPE_HEADER_NAME],
    );

    // Meme refus, exactement, que le webhook de stockage : un 401 nu, sans
    // corps qui distinguerait « en-tete absent » de « secret faux ».
    if (
      presented_secret === null ||
      !matches_internal_shared_secret(
        presented_secret,
        this.environment.internal_storage_webhook_secret,
      )
    ) {
      throw new UnauthorizedException();
    }

    const rendered: RenderedMetrics = await this.metrics.render();
    response.setHeader('content-type', rendered.content_type);
    return rendered.body;
  }
}
