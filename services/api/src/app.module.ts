import { DynamicModule, Module } from '@nestjs/common';
import { ENV, type Env } from './core/config/env';
import { DatabaseModule } from './core/database/database.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LocationsModule } from './modules/locations/locations.module';

/**
 * Root module. Core (config, database) is global; each business domain is a module
 * under src/modules. See docs/ARCHITECTURE.md §2 for allowed dependencies.
 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, HealthModule, CatalogModule, LocationsModule, InventoryModule],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
