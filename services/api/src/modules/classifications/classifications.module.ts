import { Module } from '@nestjs/common';
import { ClassificationsController } from './classifications.controller';
import { ClassificationsRepository } from './classifications.repository';
import { ClassificationsService } from './classifications.service';

/** ABC/XYZ classification (V2 step 2a). Reads sales history and costs; writes its own tables. */
@Module({
  controllers: [ClassificationsController],
  providers: [ClassificationsService, ClassificationsRepository],
  exports: [ClassificationsService],
})
export class ClassificationsModule {}
