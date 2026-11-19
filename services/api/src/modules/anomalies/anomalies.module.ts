import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { AnomaliesController } from './anomalies.controller';
import { AnomaliesRepository } from './anomalies.repository';
import { AnomaliesService } from './anomalies.service';
import { OperationsAnomalyConsumer } from './operations.consumer';

/**
 * Unusual sales (read from forecast.anomaly_detections) and unusual adjustments/returns (found
 * by an event consumer), plus the review workflow. Depends on events only; reads the ledger
 * read-only for its rules (decision #55).
 */
@Module({
  imports: [EventsModule],
  controllers: [AnomaliesController],
  providers: [AnomaliesService, AnomaliesRepository, OperationsAnomalyConsumer],
  exports: [AnomaliesService],
})
export class AnomaliesModule {}
