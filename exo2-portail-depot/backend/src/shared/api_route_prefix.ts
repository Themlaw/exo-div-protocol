import { RequestMethod, type INestApplication } from '@nestjs/common';
import {
  API_ROUTE_PREFIX,
  ROUTES_SERVED_OUTSIDE_THE_VERSIONED_API,
} from '../auth/auth_http_contract';

// Appele par main.ts ET par le harnais d'integration, jamais recopie : un
// prefixe pose d'un cote seulement ferait passer les tests sur une arborescence
// que la production ne sert pas.
//
// A appeler AVANT `app.init()`, comme tout ce qui touche au routeur.
export function apply_api_route_prefix(app: INestApplication): void {
  app.setGlobalPrefix(API_ROUTE_PREFIX, {
    exclude: ROUTES_SERVED_OUTSIDE_THE_VERSIONED_API.map((path: string) => ({
      path,
      method: RequestMethod.ALL,
    })),
  });
}
