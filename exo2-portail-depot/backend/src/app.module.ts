import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ConfigurationModule } from './config/configuration.module';
import { LoggingModule } from './shared/logging/logging.module';
import { ClockModule } from './shared/clock.module';
import { Argon2ConcurrencyModule } from './shared/argon2_concurrency.module';
import { AccessLinkModule } from './access_link/access_link.module';
import { ActivityModule } from './activity/activity.module';
import { DepositSessionModule } from './deposit_session/deposit_session.module';
import { DepositedFileModule } from './deposited_file/deposited_file.module';
import { ObjectStorageModule } from './object_storage/object_storage.module';
import { ScanModule } from './scan/scan.module';
import { ClientDepositSessionGuard } from './deposit_session/client_deposit_session.guard';
import { DatabaseModule } from './db/database.module';
import { LawyerAuthModule } from './auth/lawyer_auth.module';
import { DepositModule } from './deposit/deposit.module';
import { HealthModule } from './health/health.module';
import { InternalStorageModule } from './storage/internal_storage.module';
import { RouteAccessStartupAudit } from './auth/route_access_startup_audit';
import { RouteAccessGuard } from './auth/route_access.guard';
import { UnroutedRequestFilter } from './auth/unrouted_request.filter';

@Module({
  // DiscoveryModule : c'est lui qui rend `DiscoveryService` injectable, et donc
  // le recensement des routes possible. Sans lui, l'outil cense prouver
  // qu'aucune route n'est ouverte par omission ne demarrerait pas.
  imports: [
    DiscoveryModule,
    ConfigurationModule,
    LoggingModule,
    ClockModule,
    Argon2ConcurrencyModule,
    AccessLinkModule,
    ActivityModule,
    DepositSessionModule,
    DepositedFileModule,
    ObjectStorageModule,
    ScanModule,
    DatabaseModule,
    LawyerAuthModule,
    DepositModule,
    HealthModule,
    InternalStorageModule,
  ],
  controllers: [],
  providers: [
    RouteAccessStartupAudit,
    // Global, et c'est tout l'interet : une route ajoutee demain est fermee
    // sans que son auteur ait a y penser.
    { provide: APP_GUARD, useClass: RouteAccessGuard },
    // Le second mecanisme, et un garde a lui : le premier laisse passer tout ce
    // qui n'est pas 'lawyer', celui-ci ne connait que la session de depot.
    { provide: APP_GUARD, useClass: ClientDepositSessionGuard },
    { provide: APP_FILTER, useClass: UnroutedRequestFilter },
  ],
})
export class AppModule {}
