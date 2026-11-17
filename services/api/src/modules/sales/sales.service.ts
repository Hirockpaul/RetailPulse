import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import type { RequestContext } from '../../core/http/request-context';
import {
  IdempotencyService,
  type IdempotentResult,
} from '../../core/idempotency/idempotency.service';
import { InventoryService, sortByProduct } from '../inventory/inventory.service';
import { LocationsService } from '../locations/locations.service';
import { SalesRepository } from './sales.repository';
import type { CreateSaleBody, SalesOrder } from './sales.schemas';

@Injectable()
export class SalesService {
  constructor(
    private readonly repo: SalesRepository,
    private readonly inventory: InventoryService,
    private readonly locations: LocationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Simulated POS sale. One transaction: idempotency key → order + lines → one SALE ledger
   * movement per line. Any failure (e.g. insufficient stock on the 3rd line) rolls back all of it.
   */
  async createSale(
    dto: CreateSaleBody,
    key: string,
    ctx: RequestContext,
  ): Promise<IdempotentResult<SalesOrder>> {
    assertLocationAccess(ctx.user, dto.locationId); // 403 outside a store manager's stores
    const location = await this.locations.get(dto.locationId); // 404 if missing
    if (location.type !== 'STORE') {
      throw new UnprocessableEntityException({
        code: 'INVALID_LOCATION_TYPE',
        message: 'Sales can only be recorded at a store.',
      });
    }

    return this.idempotency.execute(
      { key, endpoint: 'POST /sales', request: dto },
      async (client) => {
        const { missing, inactive } = await this.repo.checkProducts(
          client,
          dto.lines.map((l) => l.productId),
        );
        if (missing.length > 0) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'Product not found.',
            details: missing.map((productId) => ({ productId })),
          });
        }
        if (inactive.length > 0) {
          throw new ConflictException({
            code: 'PRODUCT_INACTIVE',
            message: 'Inactive products cannot be sold.',
            details: inactive.map((productId) => ({ productId })),
          });
        }

        const order = await this.repo.createOrder(client, dto, ctx.correlationId);

        // Fixed lock order (by product) so concurrent multi-line sales cannot deadlock.
        for (const line of sortByProduct(dto.lines)) {
          await this.inventory.applyMovement(client, {
            productId: line.productId,
            locationId: dto.locationId,
            type: 'SALE',
            onHandDelta: -line.quantity,
            reason: 'POS sale (simulated)',
            referenceType: 'SALES_ORDER',
            referenceId: order.id,
            correlationId: ctx.correlationId,
            actorId: ctx.user.id,
          });
        }
        return { status: 201, body: order };
      },
    );
  }

  async getSale(id: string, user: AuthUser): Promise<SalesOrder> {
    const order = await this.repo.findOrder(id);
    if (!order)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sales order not found.' });
    assertLocationAccess(user, order.locationId);
    return order;
  }
}
