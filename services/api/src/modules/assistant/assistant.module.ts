import { Module } from '@nestjs/common';
import { AnomaliesModule } from '../anomalies/anomalies.module';
import { OverviewModule } from '../overview/overview.module';
import { ReplenishmentModule } from '../replenishment/replenishment.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantTools } from './assistant.tools';

@Module({
  imports: [OverviewModule, AnomaliesModule, ReplenishmentModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools],
})
export class AssistantModule {}
