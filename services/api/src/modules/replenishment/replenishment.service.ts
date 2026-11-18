import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { accessibleLocationIds, assertLocationAccess } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { DatabaseService } from '../../core/database/database.service';
import type { Page } from '../../core/http/query';
import type { RequestContext } from '../../core/http/request-context';
import { ClassificationsService } from '../classifications/classifications.service';
import { ForecastsService } from '../forecasts/forecasts.service';
import { PurchasingService } from '../purchasing/purchasing.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { TransfersService } from '../transfers/transfers.service';
import { type DcStock, explain, plan, serviceLevelFor } from './replenishment.calc';
import { REPLENISHMENT } from './replenishment.config';
import { ReplenishmentRepository } from './replenishment.repository';
import type {
  DecisionBody,
  ListRecommendationsQuery,
  NewRecommendation,
  PairRow,
  RecommendationDetail,
  RecommendationSummary,
} from './replenishment.schemas';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface GenerateResult {
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  evaluated: number;
  created: number;
  expired: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number };
  byRisk: { CRITICAL: number; HIGH: number };
  skipped: { noNeed: number; noSource: number };
}

/**
 * Turns the latest forecast into recommendations for a manager. Generating NEVER creates a
 * transfer or purchase order and never moves stock: only a person approving one does.
 */
@Injectable()
export class ReplenishmentService {
  constructor(
    private readonly repo: ReplenishmentRepository,
    private readonly forecasts: ForecastsService,
    private readonly transfers: TransfersService,
    private readonly purchasing: PurchasingService,
    private readonly suppliers: SuppliersService,
    private readonly classifications: ClassificationsService,
    private readonly db: DatabaseService,
  ) {}

  async generate(): Promise<GenerateResult> {
    const run = await this.forecasts.latestSucceededRun();
    if (!run) {
      throw new ConflictException({
        code: 'NO_FORECAST',
        message: 'There is no forecast yet. Run a forecast first.',
      });
    }
    const [pairs, dcByProduct, delays, classified] = await Promise.all([
      this.repo.loadPairs(run.id),
      this.repo.loadDcStock(),
      this.suppliers.delays(),
      this.classifications.latestStoreClasses(),
    ]);

    // Most urgent first, so scarce distribution-centre stock goes to the stores that need it most.
    const urgency = (p: PairRow) => {
      const daily = mean(p.yhat);
      return daily > 0 ? (p.onHand - p.reserved + p.inbound) / daily : Number.POSITIVE_INFINITY;
    };
    const ordered = [...pairs].sort(
      (a, b) => urgency(a) - urgency(b) || a.sku.localeCompare(b.sku),
    );

    const remaining = new Map<string, DcStock[]>();
    for (const [productId, dcs] of dcByProduct)
      remaining.set(
        productId,
        dcs.map((d) => ({ ...d })),
      );

    const recommendations: NewRecommendation[] = [];
    const result: GenerateResult = {
      forecastRunId: run.id,
      forecastHistoryEnd: run.historyEnd,
      evaluated: pairs.length,
      created: 0,
      expired: 0,
      byAction: { TRANSFER: 0, PURCHASE_ORDER: 0 },
      byRisk: { CRITICAL: 0, HIGH: 0 },
      skipped: { noNeed: 0, noSource: 0 },
    };

    for (const pair of ordered) {
      const supplier =
        pair.supplierId &&
        pair.leadTimeDays !== null &&
        pair.minOrderQty !== null &&
        pair.unitCost !== null
          ? {
              id: pair.supplierId,
              name: pair.supplierName ?? 'supplier',
              leadTimeDays: pair.leadTimeDays,
              minOrderQty: pair.minOrderQty,
              unitCost: pair.unitCost,
            }
          : null;
      const available = pair.onHand - pair.reserved;
      const cls = classified.classes.get(`${pair.productId}:${pair.locationId}`) ?? null;
      const { serviceLevel, z } = serviceLevelFor(cls);
      const outcome = plan({
        yhat: pair.yhat,
        sigmaError: pair.sigmaError,
        packSize: pair.packSize,
        available,
        inbound: pair.inbound,
        supplier,
        supplierDelay: (pair.supplierId && delays.get(pair.supplierId)) || null,
        dcs: remaining.get(pair.productId) ?? [],
        serviceLevelZ: z,
        reviewPeriodDays: REPLENISHMENT.reviewPeriodDays,
        transferLeadTimeDays: REPLENISHMENT.transferLeadTimeDays,
        minSupplierDeliveries: REPLENISHMENT.minSupplierDeliveries,
      });
      if ('skip' in outcome) {
        if (outcome.skip === 'NO_NEED') result.skipped.noNeed++;
        else result.skipped.noSource++;
        continue;
      }
      const p = outcome.plan;
      if (p.action === 'TRANSFER' && p.sourceDc) {
        // Reserve this stock in the batch so the next store does not count it again.
        const dc = (remaining.get(pair.productId) ?? []).find(
          (d) => d.locationId === p.sourceDc!.locationId,
        );
        if (dc) dc.availableNet -= p.quantity;
      }

      recommendations.push({
        forecastRunId: run.id,
        productId: pair.productId,
        locationId: pair.locationId,
        action: p.action,
        sourceLocationId: p.sourceDc?.locationId ?? null,
        supplierId: p.supplier?.id ?? null,
        quantity: p.quantity,
        risk: p.risk,
        daysOfCover: p.daysOfCover,
        explanation: explain(p, {
          sku: pair.sku,
          locationCode: pair.locationCode,
          model: pair.model,
          isFallback: pair.isFallback,
          sigmaError: pair.sigmaError,
          cls,
          serviceLevel,
          serviceLevelZ: z,
          reviewPeriodDays: REPLENISHMENT.reviewPeriodDays,
          packSize: pair.packSize,
          available,
          inbound: pair.inbound,
        }),
        inputs: {
          forecast: {
            runId: run.id,
            model: pair.model,
            isFallback: pair.isFallback,
            historyDays: pair.historyDays,
            testWape: pair.testWape,
            demandDuringLead: p.demandDuringLead,
            demandDuringCover: p.demandDuringCover,
            avgDailyDemand: p.avgDailyDemand,
            sigmaError: pair.sigmaError,
          },
          parameters: {
            serviceLevel,
            classification: { cls, runId: classified.runId },
            serviceLevelZ: z,
            reviewPeriodDays: REPLENISHMENT.reviewPeriodDays,
            leadTimeDays: p.leadTimeDays,
            leadTimeSource: p.leadTimeSource,
            leadTimeStdDays: p.leadTimeStdDays,
            leadTimeBasis: p.leadTimeBasis,
            supplierDeliveries: p.leadTimeDeliveries,
            packSize: pair.packSize,
            minOrderQty: p.supplier?.minOrderQty ?? null,
          },
          stock: {
            onHand: pair.onHand,
            reserved: pair.reserved,
            available,
            inbound: pair.inbound,
            position: p.position,
          },
          calculation: {
            safetyStock: p.safetyStock,
            safetyStockParts: p.safetyStockParts,
            reorderPoint: p.reorderPoint,
            orderUpTo: p.orderUpTo,
            rawQuantity: p.rawQuantity,
            quantity: p.quantity,
            daysOfCover: p.daysOfCover,
          },
          source: p.sourceDc
            ? { code: p.sourceDc.code, availableNet: p.sourceDc.availableNet }
            : null,
          supplier: p.supplier,
          dcShortfall: p.dcShortfall,
        },
      });
      result.created++;
      result.byAction[p.action]++;
      result.byRisk[p.risk]++;
    }

    result.expired = await this.db.transaction(async (client) => {
      await this.repo.lockGeneration(client);
      const expired = await this.repo.expirePending(client);
      for (const r of recommendations) await this.repo.insert(client, r);
      return expired;
    });
    return result;
  }

  /** Store managers see recommendations for their own stores only. */
  async list(
    query: ListRecommendationsQuery,
    user: AuthUser,
  ): Promise<Page<RecommendationSummary>> {
    if (query.locationId) assertLocationAccess(user, query.locationId);
    const { rows, total } = await this.repo.list(query, accessibleLocationIds(user));
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<RecommendationDetail> {
    const rec = await this.repo.find(id);
    if (!rec) throw notFound();
    assertLocationAccess(user, rec.locationId);
    return rec;
  }

  /**
   * A manager approves: the transfer (already approved) or purchase order is created in the
   * same transaction. Stock still moves only later (dispatch/receive of the transfer, receipt of
   * the order). Approving twice is a 409.
   */
  approve(id: string, body: DecisionBody, ctx: RequestContext): Promise<RecommendationDetail> {
    return this.db.transaction(async (client) => {
      const rec = await this.repo.lock(client, id);
      if (!rec) throw notFound();
      assertPending(rec.status);

      let links: { transferId?: string; purchaseOrderId?: string };
      if (rec.action === 'TRANSFER' && rec.sourceLocationId) {
        links = {
          transferId: await this.transfers.createApproved(
            client,
            {
              sourceLocationId: rec.sourceLocationId,
              destinationLocationId: rec.locationId,
              notes: `Replenishment recommendation ${id}`,
              lines: [{ productId: rec.productId, quantity: rec.quantity }],
            },
            ctx.user.id,
          ),
        };
      } else if (rec.supplierId && rec.inputs.supplier) {
        links = {
          purchaseOrderId: await this.purchasing.createApproved(
            client,
            {
              supplierId: rec.supplierId,
              destinationLocationId: rec.locationId,
              expectedInDays: rec.inputs.supplier.leadTimeDays,
              notes: `Replenishment recommendation ${id}`,
              lines: [
                {
                  productId: rec.productId,
                  quantity: rec.quantity,
                  unitCost: rec.inputs.supplier.unitCost,
                },
              ],
            },
            ctx.user.id,
          ),
        };
      } else {
        throw new Error('Recommendation has neither a source location nor a supplier.');
      }
      await this.repo.decide(client, id, 'APPROVED', ctx.user.id, body.note, links);
      return this.reload(client, id);
    });
  }

  reject(id: string, body: DecisionBody, ctx: RequestContext): Promise<RecommendationDetail> {
    return this.db.transaction(async (client) => {
      const rec = await this.repo.lock(client, id);
      if (!rec) throw notFound();
      assertPending(rec.status);
      await this.repo.decide(client, id, 'REJECTED', ctx.user.id, body.note, {});
      return this.reload(client, id);
    });
  }

  private async reload(
    client: Parameters<ReplenishmentRepository['find']>[1],
    id: string,
  ): Promise<RecommendationDetail> {
    const rec = await this.repo.find(id, client);
    if (!rec) throw new Error('Recommendation vanished inside its own transaction.');
    return rec;
  }
}

function assertPending(status: string) {
  if (status !== 'PENDING') {
    throw new ConflictException({
      code: 'INVALID_STATE_TRANSITION',
      message: `Recommendation is ${status}; only a PENDING recommendation can be decided.`,
    });
  }
}

function notFound() {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Recommendation not found.' });
}
