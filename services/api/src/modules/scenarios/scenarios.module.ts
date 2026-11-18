import { Module } from '@nestjs/common';
import { ReplenishmentModule } from '../replenishment/replenishment.module';
import { ScenariosController } from './scenarios.controller';
import { ScenariosRepository } from './scenarios.repository';
import { ScenariosService } from './scenarios.service';

/** What-if scenarios (V2 4b): calls replenishment's in-memory batch; writes only its own tables. */
@Module({
  imports: [ReplenishmentModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, ScenariosRepository],
})
export class ScenariosModule {}
