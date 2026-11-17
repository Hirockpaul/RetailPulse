import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import {
  IdempotencyService,
  type IdempotentResult,
} from '../../core/idempotency/idempotency.service';
import type { Page } from '../../core/http/query';
import { InventoryService } from '../inventory/inventory.service';
import { ReservationsRepository } from './reservations.repository';
import type {
  CreateReservationBody,
  ListReservationsQuery,
  Reservation,
} from './reservations.schemas';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly repo: ReservationsRepository,
    private readonly inventory: InventoryService,
    private readonly idempotency: IdempotencyService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Reserve stock: lowers *available* but not *on hand*. Writes a RESERVATION ledger movement
   * and the reservation record in one transaction; 409 INSUFFICIENT_STOCK if not enough is free.
   */
  create(
    dto: CreateReservationBody,
    key: string,
    correlationId?: string,
  ): Promise<IdempotentResult<Reservation>> {
    return this.idempotency.execute(
      { key, endpoint: 'POST /reservations', request: dto },
      async (client) => {
        const id = randomUUID();
        // Ledger first: it validates product/location and available stock (translated errors).
        await this.inventory.applyMovement(client, {
          productId: dto.productId,
          locationId: dto.locationId,
          type: 'RESERVATION',
          onHandDelta: 0,
          reservedDelta: dto.quantity,
          reason: dto.reference ?? 'Stock reserved',
          referenceType: 'RESERVATION',
          referenceId: id,
          correlationId,
        });
        await this.repo.insert(client, { id, ...dto });
        const reservation = await this.repo.find(id, client);
        if (!reservation) throw new Error('Reservation vanished inside its own transaction.');
        return { status: 201, body: reservation };
      },
    );
  }

  /** ACTIVE → RELEASED. Restores availability. A second release is 409 INVALID_STATE_TRANSITION. */
  release(id: string, correlationId?: string): Promise<Reservation> {
    return this.db.transaction(async (client) => {
      const current = await this.repo.lockForUpdate(client, id);
      if (!current) throw notFound();
      if (current.status !== 'ACTIVE') {
        throw new ConflictException({
          code: 'INVALID_STATE_TRANSITION',
          message: `Reservation is ${current.status}; only ACTIVE reservations can be released.`,
        });
      }
      await this.inventory.applyMovement(client, {
        productId: current.productId,
        locationId: current.locationId,
        type: 'RESERVATION_RELEASE',
        onHandDelta: 0,
        reservedDelta: -current.quantity,
        reason: 'Reservation released',
        referenceType: 'RESERVATION',
        referenceId: id,
        correlationId,
      });
      await this.repo.markReleased(client, id);
      const released = await this.repo.find(id, client);
      if (!released) throw new Error('Reservation vanished inside its own transaction.');
      return released;
    });
  }

  async get(id: string): Promise<Reservation> {
    const reservation = await this.repo.find(id);
    if (!reservation) throw notFound();
    return reservation;
  }

  async list(query: ListReservationsQuery): Promise<Page<Reservation>> {
    const { rows, total } = await this.repo.list(query);
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }
}

function notFound() {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Reservation not found.' });
}
