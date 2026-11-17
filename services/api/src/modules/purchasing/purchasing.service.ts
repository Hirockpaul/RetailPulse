import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { accessibleLocationIds, assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import type { RequestContext } from '../../core/http/request-context';
import { InventoryService, sortByProduct } from '../inventory/inventory.service';
import { PurchasingRepository } from './purchasing.repository';
import type {
  ListPurchaseOrdersQuery,
  NewPurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderSummary,
} from './purchasing.schemas';

/**
 * Purchase orders. They are created only by approving a replenishment recommendation (a person
 * decides), start APPROVED, and add stock only when received — through the inventory ledger.
 */
@Injectable()
export class PurchasingService {
  constructor(
    private readonly repo: PurchasingRepository,
    private readonly inventory: InventoryService,
    private readonly db: DatabaseService,
  ) {}

  /** Create an APPROVED purchase order inside the caller's transaction. */
  createApproved(client: PoolClient, po: NewPurchaseOrder, userId: string): Promise<string> {
    return this.repo.insert(client, po, userId);
  }

  async list(query: ListPurchaseOrdersQuery, user: AuthUser): Promise<Page<PurchaseOrderSummary>> {
    if (query.locationId) assertLocationAccess(user, query.locationId);
    const { rows, total } = await this.repo.list(query, accessibleLocationIds(user));
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<PurchaseOrderDetail> {
    const po = await this.repo.find(id);
    if (!po) throw notFound();
    assertLocationAccess(user, po.destinationLocationId);
    return po;
  }

  /** The delivery arrived: RECEIPT movements at the destination, then APPROVED → RECEIVED. */
  receive(id: string, ctx: RequestContext): Promise<PurchaseOrderDetail> {
    return this.db.transaction(async (client) => {
      const current = await this.repo.lock(client, id);
      if (!current) throw notFound();
      assertLocationAccess(ctx.user, current.destinationLocationId);
      assertApproved(current.status, 'received');
      for (const line of sortByProduct(await this.repo.lines(client, id))) {
        await this.inventory.applyMovement(client, {
          productId: line.productId,
          locationId: current.destinationLocationId,
          type: 'RECEIPT',
          onHandDelta: line.quantity,
          reason: 'Purchase order received',
          referenceType: 'PURCHASE_ORDER',
          referenceId: id,
          correlationId: ctx.correlationId,
          actorId: ctx.user.id,
        });
      }
      await this.repo.transition(client, id, 'RECEIVED', ctx.user.id);
      return this.reload(client, id);
    });
  }

  /** Cancel an order that has not arrived. No stock was ever added, so nothing to undo. */
  cancel(id: string, ctx: RequestContext): Promise<PurchaseOrderDetail> {
    return this.db.transaction(async (client) => {
      const current = await this.repo.lock(client, id);
      if (!current) throw notFound();
      assertApproved(current.status, 'cancelled');
      await this.repo.transition(client, id, 'CANCELLED', ctx.user.id);
      return this.reload(client, id);
    });
  }

  private async reload(client: PoolClient, id: string): Promise<PurchaseOrderDetail> {
    const po = await this.repo.find(id, client);
    if (!po) throw new Error('Purchase order vanished inside its own transaction.');
    return po;
  }
}

function assertApproved(status: string, verb: string) {
  if (status !== 'APPROVED') {
    throw new ConflictException({
      code: 'INVALID_STATE_TRANSITION',
      message: `Purchase order is ${status}; only an APPROVED order can be ${verb}.`,
    });
  }
}

function notFound() {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found.' });
}
