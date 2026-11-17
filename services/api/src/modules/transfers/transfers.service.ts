import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  accessibleLocationIds,
  assertLocationAccess,
  canAccessLocation,
  forbidden,
} from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import type { RequestContext } from '../../core/http/request-context';
import {
  IdempotencyService,
  type IdempotentResult,
} from '../../core/idempotency/idempotency.service';
import { InventoryService, sortByProduct } from '../inventory/inventory.service';
import { LocationsService } from '../locations/locations.service';
import { type LockedTransfer, TransfersRepository } from './transfers.repository';
import type {
  CreateTransferBody,
  ListTransfersQuery,
  TransferDetail,
  TransferStatus,
  TransferSummary,
} from './transfers.schemas';

interface Step {
  to: Exclude<TransferStatus, 'REQUESTED'>;
  /** Statuses this step may start from. Anything else → 409 INVALID_STATE_TRANSITION. */
  from: TransferStatus[];
  /** Object-level check (store managers). Role checks are on the route. */
  authorize: (user: AuthUser, t: LockedTransfer) => void;
  /** Stock effects, run in the same transaction as the status change. */
  effects?: (
    client: PoolClient,
    id: string,
    t: LockedTransfer,
    ctx: RequestContext,
  ) => Promise<void>;
}

/**
 * Transfer lifecycle: REQUESTED → APPROVED → DISPATCHED → RECEIVED (or CANCELLED before dispatch).
 *  - dispatch writes TRANSFER_OUT at the source, receipt writes TRANSFER_IN at the destination —
 *    always via InventoryService.applyMovement(), never by editing balances;
 *  - stock "in transit" (dispatched, not yet received) is on neither location's on-hand and is
 *    visible as `inbound` at the destination (derived from open transfers).
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly repo: TransfersRepository,
    private readonly inventory: InventoryService,
    private readonly locations: LocationsService,
    private readonly idempotency: IdempotencyService,
    private readonly db: DatabaseService,
  ) {}

  // ------------------------------------------------------------------ steps

  private readonly steps: Record<'approve' | 'dispatch' | 'receive' | 'cancel', Step> = {
    // Roles (admin / inventory manager only) are enforced on the route.
    approve: { to: 'APPROVED', from: ['REQUESTED'], authorize: () => undefined },

    dispatch: {
      to: 'DISPATCHED',
      from: ['APPROVED'],
      authorize: (user, t) => assertLocationAccess(user, t.sourceLocationId),
      effects: async (client, id, t, ctx) => {
        for (const line of sortByProduct(await this.repo.lines(client, id))) {
          await this.inventory.applyMovement(client, {
            productId: line.productId,
            locationId: t.sourceLocationId,
            type: 'TRANSFER_OUT',
            onHandDelta: -line.quantity,
            reason: 'Transfer dispatched',
            referenceType: 'TRANSFER',
            referenceId: id,
            correlationId: ctx.correlationId,
            actorId: ctx.user.id,
          });
        }
      },
    },

    receive: {
      to: 'RECEIVED',
      from: ['DISPATCHED'],
      authorize: (user, t) => assertLocationAccess(user, t.destinationLocationId),
      effects: async (client, id, t, ctx) => {
        for (const line of sortByProduct(await this.repo.lines(client, id))) {
          await this.inventory.applyMovement(client, {
            productId: line.productId,
            locationId: t.destinationLocationId,
            type: 'TRANSFER_IN',
            onHandDelta: line.quantity,
            reason: 'Transfer received',
            referenceType: 'TRANSFER',
            referenceId: id,
            correlationId: ctx.correlationId,
            actorId: ctx.user.id,
          });
        }
      },
    },

    cancel: {
      to: 'CANCELLED',
      from: ['REQUESTED', 'APPROVED'],
      authorize: (user, t) => {
        if (
          !canAccessLocation(user, t.sourceLocationId) &&
          !canAccessLocation(user, t.destinationLocationId)
        ) {
          throw forbidden();
        }
      },
    },
  };

  approve(id: string, ctx: RequestContext) {
    return this.transition(id, ctx, this.steps.approve);
  }
  dispatch(id: string, ctx: RequestContext) {
    return this.transition(id, ctx, this.steps.dispatch);
  }
  receive(id: string, ctx: RequestContext) {
    return this.transition(id, ctx, this.steps.receive);
  }
  cancel(id: string, ctx: RequestContext) {
    return this.transition(id, ctx, this.steps.cancel);
  }

  /** lock row → authorize → check state → stock effects → update status, all in one transaction. */
  private transition(id: string, ctx: RequestContext, step: Step): Promise<TransferDetail> {
    return this.db.transaction(async (client) => {
      const current = await this.repo.lock(client, id);
      if (!current) throw notFound();
      step.authorize(ctx.user, current);
      if (!step.from.includes(current.status)) {
        throw new ConflictException({
          code: 'INVALID_STATE_TRANSITION',
          message: `Transfer is ${current.status}; this step needs ${step.from.join(' or ')}.`,
        });
      }
      if (step.effects) await step.effects(client, id, current, ctx);
      await this.repo.transition(client, id, step.to, ctx.user.id);
      const updated = await this.repo.find(id, client);
      if (!updated) throw new Error('Transfer vanished inside its own transaction.');
      return updated;
    });
  }

  // ----------------------------------------------------------------- create

  /**
   * Request a transfer. Store managers may only request transfers INTO their own stores.
   * Nothing moves until it is approved and dispatched.
   */
  async create(
    dto: CreateTransferBody,
    key: string,
    ctx: RequestContext,
  ): Promise<IdempotentResult<TransferDetail>> {
    assertLocationAccess(ctx.user, dto.destinationLocationId);
    await Promise.all([
      this.locations.get(dto.sourceLocationId), // 404 if missing
      this.locations.get(dto.destinationLocationId),
    ]);

    return this.idempotency.execute(
      { key, endpoint: 'POST /transfers', request: dto },
      async (client) => {
        let id: string;
        try {
          id = await this.repo.insert(client, dto, ctx.user.id);
          await this.repo.insertLines(client, id, dto.lines);
        } catch (err) {
          if ((err as { code?: string }).code === '23503') {
            throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found.' });
          }
          throw err;
        }
        const created = await this.repo.find(id, client);
        if (!created) throw new Error('Transfer vanished inside its own transaction.');
        return { status: 201, body: created };
      },
    );
  }

  // ------------------------------------------------------------------ reads

  async get(id: string, user: AuthUser): Promise<TransferDetail> {
    const transfer = await this.repo.find(id);
    if (!transfer) throw notFound();
    if (
      !canAccessLocation(user, transfer.sourceLocationId) &&
      !canAccessLocation(user, transfer.destinationLocationId)
    ) {
      throw forbidden();
    }
    return transfer;
  }

  /** Store managers see transfers touching their stores; everyone else sees all. */
  async list(query: ListTransfersQuery, user: AuthUser): Promise<Page<TransferSummary>> {
    const { rows, total } = await this.repo.list(query, accessibleLocationIds(user));
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }
}

function notFound() {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found.' });
}
