import { Global, Module } from '@nestjs/common';
import { AiClient, AI_FETCH, AI_SLEEP } from './ai.client';
import { AiRepository } from './ai.repository';
import { AiService } from './ai.service';

@Global()
@Module({
  providers: [
    AiService,
    AiRepository,
    AiClient,
    {
      provide: AI_FETCH,
      useValue: (url: string, init: RequestInit) => fetch(url, init),
    },
    {
      provide: AI_SLEEP,
      useValue: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    },
  ],
  exports: [AiService],
})
export class AiModule {}
