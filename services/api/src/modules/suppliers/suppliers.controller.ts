import { Controller, Get, Param } from '@nestjs/common';
import { READ_ROLES, Roles } from '../../core/auth/roles';
import { idParamSchema } from '../../core/http/query';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { SuppliersService } from './suppliers.service';

/** Supplier performance (V2 step 2c). Network-wide statistics; read-only. */
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Roles(...READ_ROLES)
  @Get('performance')
  list() {
    return this.suppliers.list();
  }

  /** One supplier: its statistics, per product, and its latest deliveries (store-scoped). */
  @Roles(...READ_ROLES)
  @Get(':id/performance')
  get(
    @Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string },
    @Ctx() ctx: RequestContext,
  ) {
    return this.suppliers.get(id, ctx.user);
  }
}
