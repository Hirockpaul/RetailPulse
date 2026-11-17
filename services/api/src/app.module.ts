import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthCoreModule } from './core/auth/auth-core.module';
import { AuthGuard } from './core/auth/auth.guard';
import { ENV, type Env } from './core/config/env';
import { DatabaseModule } from './core/database/database.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { EventsModule } from './modules/events/events.module';
import { ForecastsModule } from './modules/forecasts/forecasts.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LocationsModule } from './modules/locations/locations.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { SalesModule } from './modules/sales/sales.module';
import { TransfersModule } from './modules/transfers/transfers.module';

/**
 * Root module. Core (config, database, sessions) is global; each business domain is a module
 * under src/modules. See docs/ARCHITECTURE.md §2 for allowed dependencies.
 * The AuthGuard is global: every route needs a session and an allowed role unless @Public().
 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DatabaseModule,
        AuthCoreModule,
        AuthModule,
        HealthModule,
        CatalogModule,
        LocationsModule,
        InventoryModule,
        SalesModule,
        ReservationsModule,
        TransfersModule,
        EventsModule,
        AlertsModule,
        ForecastsModule,
        PurchasingModule,
        ReplenishmentModule,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [ENV],
    };
  }
}
