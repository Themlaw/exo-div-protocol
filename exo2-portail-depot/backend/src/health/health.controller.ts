import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { HealthRoute } from '../auth/route_access';
import { HEALTH_PATH, READINESS_PATH } from '../auth/auth_http_contract';
import { APPLICATION_DATABASE } from '../db/database.module';
import type { ApplicationDatabase } from '../db/database_connection';

// Deux sondes distinctes parce qu'elles repondent a deux questions differentes.
// `/health` dit « le processus est vivant » : Docker s'en sert pour decider de
// redemarrer le conteneur, et il ne doit donc PAS dependre de Postgres — une
// base momentanement injoignable ferait tuer un service parfaitement sain.
// `/health/ready` dit « le service peut travailler » : c'est celle-la qu'un
// futur repartiteur de charge doit interroger avant d'envoyer du trafic.
@Controller()
@HealthRoute()
export class HealthController {
  constructor(
    @Inject(APPLICATION_DATABASE) private readonly database: ApplicationDatabase,
  ) {}

  // Reponse volontairement muette : cette route est atteignable sans
  // authentification, donc tout ce qu'elle dit est public. Ni version, ni nom
  // d'hote, ni etat des dependances — une sonde qui se raconte devient une
  // page de reconnaissance offerte.
  @Get(HEALTH_PATH)
  read_liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get(READINESS_PATH)
  async read_readiness(): Promise<{ status: string }> {
    try {
      await this.database.execute(sql`SELECT 1`);
    } catch {
      // La cause reste dans le journal du pilote : la transmettre ici la
      // rendrait lisible sans authentification.
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }

    return { status: 'ready' };
  }
}
