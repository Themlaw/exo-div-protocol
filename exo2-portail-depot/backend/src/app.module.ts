import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigurationModule } from './config/configuration.module';
import { LoggingModule } from './shared/logging/logging.module';
import { DatabaseModule } from './db/database.module';
import { LawyerAuthModule } from './auth/lawyer_auth.module';
import { RouteAccessStartupAudit } from './auth/route_access_startup_audit';

@Module({
  // DiscoveryModule : c'est lui qui rend `DiscoveryService` injectable, et donc
  // le recensement des routes possible. Sans lui, l'outil cense prouver
  // qu'aucune route n'est ouverte par omission ne demarrerait pas.
  imports: [DiscoveryModule, ConfigurationModule, LoggingModule, DatabaseModule, LawyerAuthModule],
  controllers: [],
  providers: [RouteAccessStartupAudit],
})
export class AppModule {}
