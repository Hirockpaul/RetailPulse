import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, WRITE_ROLES } from '../../core/auth/roles';
import { Ctx, type RequestContext } from '../../core/http/request-context';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { IdempotencyKey } from '../../core/idempotency/idempotency-key.decorator';
import { respond } from '../../core/idempotency/respond';
import {
  type AdjustmentBody,
  adjustmentBodySchema,
  type ReceiptBody,
  receiptBodySchema,
  type ReturnBody,
  returnBodySchema,
} from './inventory.schemas';
import { InventoryService } from './inventory.service';

/**
 * User-driven stock movements. All require an Idempotency-Key header and a write role;
 * store managers may only act in their own stores.
 */
@Roles(...WRITE_ROLES)
@Controller()
export class InventoryMovementsController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('receipts')
  async receive(
    @Body(new ZodValidationPipe(receiptBodySchema)) body: ReceiptBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.inventory.receive(body, key, ctx));
  }

  @Post('returns')
  async recordReturn(
    @Body(new ZodValidationPipe(returnBodySchema)) body: ReturnBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.inventory.recordReturn(body, key, ctx));
  }

  @Post('adjustments')
  async adjust(
    @Body(new ZodValidationPipe(adjustmentBodySchema)) body: AdjustmentBody,
    @IdempotencyKey() key: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respond(res, await this.inventory.adjust(body, key, ctx));
  }
}
