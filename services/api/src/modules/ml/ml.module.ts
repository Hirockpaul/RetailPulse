import { Module } from '@nestjs/common';
import { MlController } from './ml.controller';
import { MlRepository } from './ml.repository';
import { MlService } from './ml.service';

@Module({ controllers: [MlController], providers: [MlService, MlRepository] })
export class MlModule {}
