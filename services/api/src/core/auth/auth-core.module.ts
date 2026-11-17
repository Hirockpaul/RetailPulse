import { Global, Module } from '@nestjs/common';
import { SessionRepository } from './session.repository';
import { SessionService } from './session.service';

/** Session handling shared by the global AuthGuard and the auth module. */
@Global()
@Module({
  providers: [SessionRepository, SessionService],
  exports: [SessionService],
})
export class AuthCoreModule {}
