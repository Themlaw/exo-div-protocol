import { Global, Module } from '@nestjs/common';
import { METRICS_REGISTRY, type MetricsRegistry } from './metrics';
import { PrometheusMetricsRegistry } from './prometheus_metrics_registry';
import { MetricsController } from './metrics.controller';

// `@Global` pour la meme raison que le journal d'activite : on compte depuis
// des couches qui n'ont aucun lien entre elles — le journal, le deverrouillage
// d'un lien, la limitation de cadence — et cabler l'import dans chacune ferait
// une ligne a oublier a chaque nouveau compteur.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_REGISTRY,
      useFactory: (): MetricsRegistry => new PrometheusMetricsRegistry(),
    },
  ],
  exports: [METRICS_REGISTRY],
})
export class ObservabilityModule {}
