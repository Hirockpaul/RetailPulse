import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { accessibleLocationIds, assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import type { RequestContext } from '../../core/http/request-context';
import {
  IdempotencyService,
  type IdempotentResult,
} from '../../core/idempotency/idempotency.service';
import type { Page } from '../../core/http/query';
import { CatalogService } from '../catalog/catalog.service';
import { INVENTORY_MOVEMENT_RECORDED } from '../events/events.schemas';
import { EventsService } from '../events/events.service';
import { LocationsService } from '../locations/locations.service';
import type { Location } from '../locations/locations.schemas';
import { InventoryRepository } from './inventory.repository';
import type {
  AdjustmentBody,
  LedgerEntry,
  LedgerQuery,
  LocationStockQuery,
  LocationStockRow,
  Movement,
  MovementResult,
  ProductStockRow,
  ReceiptBody,
  StockPosition,
  ReturnBody,
  WithAsOf,
} from './inventory.schemas';

/** Constraint names from migration 0002 that mean "not enough available stock". */
const STOCK_CONSTRAINTS = new Set([
  'inventory_on_hand_non_negative',
  'inventory_reserved_non_negative',
  'inventory_reserved_within_on_hand',
]);

/**
 * The inventory module is the only owner of inventory_balances / inventory_ledger.
 * `applyMovement()` is the single write path: every stock change in the system calls it,
 * from inside the caller's transaction.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly repo: InventoryRepository,
    private readonly catalog: CatalogService,
    private readonly locations: LocationsService,
    private readonly idempotency: IdempotencyService,
    private readonly events: EventsService,
  ) {}

  // ------------------------------------------------------------------ reads

  async stockAtLocation(
    locationId: string,
    query: LocationStockQuery,
    user: AuthUser,
  ): Promise<Page<LocationStockRow> & WithAsOf & { location: Location }> {
    assertLocationAccess(user, locationId); // 403 for a store manager's other stores
    const location = await this.locations.get(locationId); // 404 if missing
    const asOf = new Date().toISOString();
    const { rows, total } = await this.repo.stockAtLocation(locationId, query);
    return { location, data: rows, page: query.page, pageSize: query.pageSize, total, asOf };
  }

  /** One row per location; a store manager only receives their own stores' rows. */
  async stockForProduct(
    productId: string,
    user: AuthUser,
  ): Promise<{ data: ProductStockRow[] } & WithAsOf> {
    await this.catalog.assertProductExists(productId);
    const asOf = new Date().toISOString();
    return {
      data: await this.repo.stockForProduct(productId, accessibleLocationIds(user)),
      asOf,
    };
  }

  async ledgerForProduct(
    productId: string,
    query: LedgerQuery,
    user: AuthUser,
  ): Promise<Page<LedgerEntry>> {
    if (query.locationId) assertLocationAccess(user, query.locationId);
    await this.catalog.assertProductExists(productId);
    const { rows, total } = await this.repo.ledgerForProduct(
      productId,
      query,
      accessibleLocationIds(user),
    );
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  // ------------------------------------------------- the single write path

  /**
   * Record one stock movement. MUST be called inside a transaction (`client`), so the movement
   * commits or rolls back together with the document that caused it (sale, reservation, …).
   *
   * Errors: 409 INSUFFICIENT_STOCK, 404 NOT_FOUND (unknown product or location).
   * After an error the transaction is aborted by PostgreSQL, so callers must not continue.
   */
  async applyMovement(client: PoolClient, movement: Movement): Promise<MovementResult> {
    let entry: MovementResult;
    try {
      entry = await this.repo.insertLedgerEntry(client, movement);
    } catch (err) {
      throw translateMovementError(err, movement);
    }

    // Same transaction as the ledger row: the event exists if and only if the movement commits.
    // Payload is business data only (no free-text reason, no personal data).
    await this.events.record(client, {
      eventType: INVENTORY_MOVEMENT_RECORDED,
      aggregateType: 'inventory_balance',
      aggregateId: `${entry.productId}:${entry.locationId}`,
      correlationId: movement.correlationId,
      occurredAt: entry.occurredAt,
      payload: {
        ledgerId: entry.ledgerId,
        productId: entry.productId,
        locationId: entry.locationId,
        movementType: entry.movementType,
        onHandDelta: entry.onHandDelta,
        reservedDelta: entry.reservedDelta,
        onHandAfter: entry.onHandAfter,
        reservedAfter: entry.reservedAfter,
        referenceType: movement.referenceType ?? null,
        referenceId: movement.referenceId ?? null,
        actorId: movement.actorId ?? null,
      },
    });
    return entry;
  }

  /** Current stock for one product at one location (inside the caller's transaction). */
  stockPosition(
    client: PoolClient,
    productId: string,
    locationId: string,
  ): Promise<StockPosition | null> {
    return this.repo.stockPosition(client, productId, locationId);
  }

  // ------------------------------------------- movements driven directly by users

  receive(
    dto: ReceiptBody,
    key: string,
    ctx: RequestContext,
  ): Promise<IdempotentResult<{ data: MovementResult[] }>> {
    assertLocationAccess(ctx.user, dto.locationId); // 403 outside a store manager's stores
    return this.idempotency.execute(
      { key, endpoint: 'POST /receipts', request: dto },
      async (client) => {
        const data: MovementResult[] = [];
        // Fixed lock order (by product) so concurrent multi-line writes cannot deadlock.
        for (const line of sortByProduct(dto.lines)) {
          data.push(
            await this.applyMovement(client, {
              productId: line.productId,
              locationId: dto.locationId,
              type: 'RECEIPT',
              onHandDelta: line.quantity,
              reason: 'Stock received',
              referenceType: dto.reference ? 'RECEIPT_REF' : undefined,
              referenceId: dto.reference,
              correlationId: ctx.correlationId,
              actorId: ctx.user.id,
            }),
          );
        }
        return { status: 201, body: { data } };
      },
    );
  }

  recordReturn(
    dto: ReturnBody,
    key: string,
    ctx: RequestContext,
  ): Promise<IdempotentResult<{ data: MovementResult[] }>> {
    assertLocationAccess(ctx.user, dto.locationId); // 403 outside a store manager's stores
    return this.idempotency.execute(
      { key, endpoint: 'POST /returns', request: dto },
      async (client) => {
        const sellable = dto.condition === 'SELLABLE';
        const note = dto.reason ? ` — ${dto.reason}` : '';
        const entry = await this.applyMovement(client, {
          productId: dto.productId,
          locationId: dto.locationId,
          type: 'RETURN',
          // Damaged returns are recorded but never restocked, so on-hand does not change.
          onHandDelta: sellable ? dto.quantity : 0,
          reason: sellable
            ? `Customer return (sellable)${note}`
            : `Damaged return: ${dto.quantity} unit(s) not restocked${note}`,
          correlationId: ctx.correlationId,
          actorId: ctx.user.id,
        });
        return { status: 201, body: { data: [entry] } };
      },
    );
  }

  adjust(
    dto: AdjustmentBody,
    key: string,
    ctx: RequestContext,
  ): Promise<IdempotentResult<{ data: MovementResult[] }>> {
    assertLocationAccess(ctx.user, dto.locationId); // 403 outside a store manager's stores
    return this.idempotency.execute(
      { key, endpoint: 'POST /adjustments', request: dto },
      async (client) => {
        const entry = await this.applyMovement(client, {
          productId: dto.productId,
          locationId: dto.locationId,
          type: 'ADJUSTMENT',
          onHandDelta: dto.delta,
          reason: dto.reason,
          correlationId: ctx.correlationId,
          actorId: ctx.user.id,
        });
        return { status: 201, body: { data: [entry] } };
      },
    );
  }
}

export function sortByProduct<T extends { productId: string }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
}

function translateMovementError(err: unknown, m: Movement): unknown {
  const e = err as { code?: string; constraint?: string };

  if (e.code === '23514' && e.constraint && STOCK_CONSTRAINTS.has(e.constraint)) {
    return new ConflictException({
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough available stock for this movement.',
      details: [{ productId: m.productId, locationId: m.locationId, movementType: m.type }],
    });
  }
  if (e.code === '23503') {
    const what = e.constraint?.includes('location') ? 'Location' : 'Product';
    return new NotFoundException({ code: 'NOT_FOUND', message: `${what} not found.` });
  }
  return err;
}
