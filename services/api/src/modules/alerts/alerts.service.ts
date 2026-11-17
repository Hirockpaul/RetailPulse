import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { accessibleLocationIds, assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import { InventoryService } from '../inventory/inventory.service';
import { AlertsRepository } from './alerts.repository';
import { type Alert, type ListAlertsQuery, stockState } from './alerts.schemas';

@Injectable()
export class AlertsService {
  constructor(
    private readonly repo: AlertsRepository,
    private readonly inventory: InventoryService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Judge the CURRENT stock of a product at a location and make its alerts match.
   * Reading current stock (not the event's numbers) keeps the result correct even if events
   * are processed late or out of order, and makes re-processing harmless.
   */
  async evaluate(
    client: PoolClient,
    productId: string,
    locationId: string,
    eventId: string | null,
  ): Promise<void> {
    const pos = await this.inventory.stockPosition(client, productId, locationId);
    if (!pos) return; // product or location no longer exists; nothing to alert about

    const state = stockState(pos.available, pos.packSize);
    const message =
      state === 'OUT_OF_STOCK'
        ? `${pos.sku} is out of stock at ${pos.locationCode}.`
        : `${pos.sku} is low at ${pos.locationCode}: ${pos.available} available, less than one pack (${pos.packSize}).`;

    await this.repo.sync(client, {
      productId,
      locationId,
      state,
      message,
      eventId,
      details: {
        rule: 'available < pack size',
        onHand: pos.onHand,
        reserved: pos.reserved,
        available: pos.available,
        packSize: pos.packSize,
        eventId,
      },
    });
  }

  /** Store managers only see alerts for their own stores. */
  async list(query: ListAlertsQuery, user: AuthUser): Promise<Page<Alert>> {
    if (query.locationId) assertLocationAccess(user, query.locationId);
    const { rows, total } = await this.repo.list(query, accessibleLocationIds(user));
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  /**
   * Re-check every low-stock position and every open alert against current stock. Used once
   * after loading data that did not go through the event path (e.g. the seed), or to repair.
   */
  async rescan(): Promise<{ evaluated: number }> {
    const candidates = await this.repo.rescanCandidates();
    // Chunks keep each transaction short (so the event worker is never blocked for long)
    // without paying for a transaction per row.
    const CHUNK = 50;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      await this.db.transaction(async (client) => {
        for (const c of candidates.slice(i, i + CHUNK)) {
          await this.evaluate(client, c.productId, c.locationId, null);
        }
      });
    }
    return { evaluated: candidates.length };
  }
}
