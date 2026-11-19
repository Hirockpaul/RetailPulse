import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AiService } from '../../core/ai/ai.service';
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
import {
  chooseDc,
  type DcStock,
  dayToDate,
  demandOver,
  excessAt,
  explain,
  explainExcess,
  plan,
  type PlanResult,
  type ReviewReason,
  reviewReason,
  serviceLevelFor,
  stockoutDay,
  type SupplierDelay,
  type SupplierTerms,
} from './replenishment.calc';
import { REPLENISHMENT } from './replenishment.config';
import { ReplenishmentRepository } from './replenishment.repository';
import {
  applyScenario,
  type BatchSummary,
  type ScenarioAdjustments,
  summarizeBatch,
} from './replenishment.scenario';
import type {
  ApproveBody,
  DecisionBody,
  ListRecommendationsQuery,
  ProductStatus,
  NewRecommendation,
  PairRow,
  RecommendationDetail,
  RecommendationSummary,
  RecommendationWords,
} from './replenishment.schemas';
import { recommendationWords } from './replenishment.words';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface GenerateResult {
  forecastRunId: string;
  forecastHistoryEnd: string | null;
  evaluated: number;
  created: number;
  expired: number;
  byAction: { TRANSFER: number; PURCHASE_ORDER: number; REDISTRIBUTE_EXCESS: number };
  byRisk: { CRITICAL: number; HIGH: number };
  /** Needs covered from another store's excess instead of a DC (V2 2d-2). */
  fromStoreExcess: number;
  skipped: { noNeed: number; noSource: number };
}

/** What generation and the status view both need besides the pair itself. */
/** Inputs of one batch, loaded once (V2 4b-1: also the snapshot a scenario adjusts). */
export interface BatchInputs {
  run: { id: string; historyEnd: string | null };
  pairs: PairRow[];
  dcByProduct: Map<string, DcStock[]>;
  delays: Map<string, SupplierDelay>;
  classified: { runId: string | null; classes: Map<string, string> };
  dcLocations: { id: string; code: string }[];
}

/** Positions by expected stockout (every evaluated pair, not only those with a recommendation). */
export interface BatchStats {
  outOfStockNow: number;
  /** Runs out on forecast day 1-7 (not already out). */
  stockoutWithin7: number;
  /** Runs out on forecast day 1-14 (not already out). */
  stockoutWithin14: number;
}

interface EvalContext {
  delays: Map<string, SupplierDelay>;
  classes: Map<string, string>;
  historyEnd: string | null;
}

/** One product × store evaluated with the pure calculation. */
interface PairEvaluation {
  outcome: PlanResult;
  supplier: SupplierTerms | null;
  available: number;
  cls: string | null;
  serviceLevel: number;
  z: number;
  review: ReviewReason | null;
  stockout: { day: number | null; date: string | null; beyondForecast: boolean };
}

function evaluatePair(
  pair: PairRow,
  dcs: DcStock[],
  ctx: EvalContext,
  storeExcess: DcStock[] = [],
): PairEvaluation {
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
  const cls = ctx.classes.get(`${pair.productId}:${pair.locationId}`) ?? null;
  const { serviceLevel, z } = serviceLevelFor(cls);
  const outcome = plan({
    yhat: pair.yhat,
    sigmaError: pair.sigmaError,
    packSize: pair.packSize,
    available,
    inbound: pair.inbound,
    supplier,
    supplierDelay: (pair.supplierId && ctx.delays.get(pair.supplierId)) || null,
    dcs,
    storeExcess,
    serviceLevelZ: z,
    reviewPeriodDays: REPLENISHMENT.reviewPeriodDays,
    transferLeadTimeDays: REPLENISHMENT.transferLeadTimeDays,
    minSupplierDeliveries: REPLENISHMENT.minSupplierDeliveries,
  });
  const so = stockoutDay(
    pair.yhat,
    available,
    available + pair.inbound,
    REPLENISHMENT.stockoutHorizonDays,
  );
  return {
    outcome,
    supplier,
    available,
    cls,
    serviceLevel,
    z,
    review: reviewReason(pair.isFallback, cls),
    stockout: {
      ...so,
      // Out of stock now (day 0) is dated the first forecast day, i.e. today.
      date:
        so.day !== null && ctx.historyEnd ? dayToDate(ctx.historyEnd, Math.max(so.day, 1)) : null,
    },
  };
}

/** A store's excess of one product: what it keeps and what it could give away (V2 2d-2). */
interface StoreExcessInfo {
  pair: PairRow;
  demandKeep: number;
  reorderPoint: number;
  keep: number;
  excess: number;
  movable: number;
}

/**
 * Excess of a product at a store, or null when the store cannot be a source: it needs stock
 * itself (by either route), its forecast is flagged for review, or no demand is forecast.
 * Its own reorder point is the larger of the DC and supplier routes, so giving stock away can
 * never push it below the point where it would need stock again.
 */
function storeExcessOf(pair: PairRow, ctx: EvalContext): StoreExcessInfo | null {
  const viaSupplier = evaluatePair(pair, [], ctx);
  const viaDc = evaluatePair(
    pair,
    [{ locationId: 'any-dc', code: 'any-dc', availableNet: Number.MAX_SAFE_INTEGER }],
    ctx,
  );
  if (viaSupplier.review || mean(pair.yhat) <= 0) return null;
  const rops: number[] = [];
  for (const o of [viaSupplier.outcome, viaDc.outcome]) {
    if ('plan' in o) return null; // needs stock by this route
    if (o.skip === 'NO_NEED') rops.push(o.reorderPoint);
  }
  if (rops.length === 0) return null;
  const reorderPoint = Math.max(...rops);
  const x = excessAt({
    yhat: pair.yhat,
    available: viaSupplier.available,
    inbound: pair.inbound,
    promisedOut: pair.promisedOut,
    packSize: pair.packSize,
    keepDays: REPLENISHMENT.excessKeepDays,
    reorderPoint,
  });
  if (x.movable <= 0) return null;
  return {
    pair,
    demandKeep: demandOver(pair.yhat, REPLENISHMENT.excessKeepDays),
    reorderPoint,
    ...x,
  };
}

/**
 * The whole replenishment batch, computed in memory from loaded inputs (no I/O, no writes):
 * 0. stores with excess, 1. needs most urgent first, 2. leftover excess back to a DC.
 * Used by generation (which then writes it) and by what-if scenarios (which only summarize it).
 */
export function computeBatch(inputs: BatchInputs): {
  recommendations: NewRecommendation[];
  result: GenerateResult;
  stats: BatchStats;
} {
  const { run, pairs, dcByProduct, delays, classified, dcLocations } = inputs;
  const stats: BatchStats = { outOfStockNow: 0, stockoutWithin7: 0, stockoutWithin14: 0 };
  // Most urgent first, so scarce distribution-centre stock goes to the stores that need it most.
  const urgency = (p: PairRow) => {
    const daily = mean(p.yhat);
    return daily > 0 ? (p.onHand - p.reserved + p.inbound) / daily : Number.POSITIVE_INFINITY;
  };
  const ordered = [...pairs].sort((a, b) => urgency(a) - urgency(b) || a.sku.localeCompare(b.sku));

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
    byAction: { TRANSFER: 0, PURCHASE_ORDER: 0, REDISTRIBUTE_EXCESS: 0 },
    byRisk: { CRITICAL: 0, HIGH: 0 },
    fromStoreExcess: 0,
    skipped: { noNeed: 0, noSource: 0 },
  };

  const ctx: EvalContext = {
    delays,
    classes: classified.classes,
    historyEnd: run.historyEnd,
  };

  // 0. Which stores have excess they could give away (V2 2d-2)?
  const excess = new Map<string, StoreExcessInfo[]>(); // by product
  for (const pair of pairs) {
    const x = storeExcessOf(pair, ctx);
    if (x) excess.set(pair.productId, [...(excess.get(pair.productId) ?? []), x]);
  }
  const otherStoresExcess = (pair: PairRow): DcStock[] =>
    (excess.get(pair.productId) ?? [])
      .filter((x) => x.pair.locationId !== pair.locationId)
      .map((x) => ({
        locationId: x.pair.locationId,
        code: x.pair.locationCode,
        availableNet: x.movable,
      }));

  // 1. Needs, most urgent first; sources: another store's excess, a DC, the supplier.
  for (const pair of ordered) {
    const { outcome, available, cls, serviceLevel, z, review, stockout } = evaluatePair(
      pair,
      remaining.get(pair.productId) ?? [],
      ctx,
      otherStoresExcess(pair),
    );
    if (stockout.day === 0) stats.outOfStockNow++;
    else if (stockout.day !== null && stockout.day <= 7) stats.stockoutWithin7++;
    if (stockout.day !== null && stockout.day > 0 && stockout.day <= 14) stats.stockoutWithin14++;
    if ('skip' in outcome) {
      if (outcome.skip === 'NO_NEED') result.skipped.noNeed++;
      else result.skipped.noSource++;
      continue;
    }
    const p = outcome.plan;
    // Take the stock out of what later stores may use in this batch.
    if (p.action === 'TRANSFER' && p.source?.kind === 'DC') {
      const dc = (remaining.get(pair.productId) ?? []).find(
        (d) => d.locationId === p.source!.locationId,
      );
      if (dc) dc.availableNet -= p.quantity;
    } else if (p.action === 'TRANSFER' && p.source?.kind === 'STORE') {
      const giver = (excess.get(pair.productId) ?? []).find(
        (x) => x.pair.locationId === p.source!.locationId,
      );
      if (giver) giver.movable -= p.quantity;
      result.fromStoreExcess++;
    }

    recommendations.push({
      forecastRunId: run.id,
      productId: pair.productId,
      locationId: pair.locationId,
      action: p.action,
      sourceLocationId: p.source?.locationId ?? null,
      supplierId: p.supplier?.id ?? null,
      destinationLocationId: null,
      quantity: p.quantity,
      risk: p.risk,
      daysOfCover: p.daysOfCover,
      expectedStockoutOn: stockout.date,
      reviewReason: review,
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
        stockout,
        review,
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
        stockout,
        review,
        source: p.source
          ? { code: p.source.code, availableNet: p.source.availableNet, kind: p.source.kind }
          : null,
        supplier: p.supplier,
        dcShortfall: p.dcShortfall,
      },
    });
    result.created++;
    result.byAction[p.action]++;
    result.byRisk[p.risk]++;
  }

  // 2. Excess no store needed → back to the DC holding the least of that product.
  const dcHeld = new Map<string, number>(); // product:dc → available, updated as we allocate
  for (const xs of excess.values()) {
    for (const x of xs) {
      if (x.movable <= 0) continue;
      const { pair } = x;
      const candidates = dcLocations.map((l) => {
        const key = `${pair.productId}:${l.id}`;
        const fromStock =
          (remaining.get(pair.productId) ?? []).find((d) => d.locationId === l.id)?.availableNet ??
          0;
        return { ...l, key, available: dcHeld.get(key) ?? fromStock };
      });
      const dc = chooseDc(candidates);
      if (!dc) continue;
      dcHeld.set(dc.key, dc.available + x.movable);
      const available = pair.onHand - pair.reserved;
      const avgKeep = x.demandKeep / REPLENISHMENT.excessKeepDays;
      const explainInput = {
        sku: pair.sku,
        locationCode: pair.locationCode,
        keepDays: REPLENISHMENT.excessKeepDays,
        demandKeep: x.demandKeep,
        reorderPoint: x.reorderPoint,
        available,
        inbound: pair.inbound,
        promisedOut: pair.promisedOut,
        packSize: pair.packSize,
        keep: x.keep,
        excess: x.excess,
        movable: x.movable,
        destinationCode: dc.code,
        destinationAvailable: dc.available,
      };
      recommendations.push({
        forecastRunId: run.id,
        productId: pair.productId,
        locationId: pair.locationId,
        action: 'REDISTRIBUTE_EXCESS',
        sourceLocationId: null,
        supplierId: null,
        destinationLocationId: dc.id,
        quantity: x.movable,
        risk: null,
        daysOfCover: avgKeep > 0 ? (available + pair.inbound) / avgKeep : null,
        expectedStockoutOn: null,
        reviewReason: null,
        explanation: explainExcess(explainInput),
        inputs: {
          kind: 'EXCESS',
          forecast: {
            runId: run.id,
            model: pair.model,
            isFallback: pair.isFallback,
            historyDays: pair.historyDays,
            testWape: pair.testWape,
            avgDailyDemand: avgKeep,
          },
          stock: {
            onHand: pair.onHand,
            reserved: pair.reserved,
            available,
            inbound: pair.inbound,
            position: available + pair.inbound,
            promisedOut: pair.promisedOut,
          },
          excess: {
            keepDays: REPLENISHMENT.excessKeepDays,
            demandKeep: x.demandKeep,
            reorderPoint: x.reorderPoint,
            keep: x.keep,
            excess: x.excess,
            movable: x.movable,
            packSize: pair.packSize,
          },
          destination: { code: dc.code, available: dc.available },
        },
      });
      result.created++;
      result.byAction.REDISTRIBUTE_EXCESS++;
    }
  }

  return { recommendations, result, stats };
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
    private readonly ai: AiService,
  ) {}

  async generate(): Promise<GenerateResult> {
    const inputs = await this.loadBatchInputs();
    const { recommendations, result } = computeBatch(inputs);
    result.expired = await this.db.transaction(async (client) => {
      await this.repo.lockGeneration(client);
      const expired = await this.repo.expirePending(client);
      for (const r of recommendations) await this.repo.insert(client, r);
      return expired;
    });
    return result;
  }

  /**
   * What-if (V2 4b-1): the same batch computed in memory twice from one loaded snapshot — as is,
   * and with the scenario's adjustments. Writes nothing.
   */
  async simulate(adjust: ScenarioAdjustments): Promise<{
    forecastRunId: string;
    forecastHistoryEnd: string | null;
    baseline: BatchSummary;
    scenario: BatchSummary;
  }> {
    const inputs = await this.loadBatchInputs();
    const adjusted = applyScenario(inputs, adjust);
    return {
      forecastRunId: inputs.run.id,
      forecastHistoryEnd: inputs.run.historyEnd,
      baseline: summarizeBatch(computeBatch(inputs), inputs.pairs),
      scenario: summarizeBatch(computeBatch(adjusted), adjusted.pairs),
    };
  }

  /** Everything a batch needs, read once (the latest forecast run, stock, terms, classes). */
  private async loadBatchInputs(): Promise<BatchInputs> {
    const run = await this.forecasts.latestSucceededRun();
    if (!run) {
      throw new ConflictException({
        code: 'NO_FORECAST',
        message: 'There is no forecast yet. Run a forecast first.',
      });
    }
    const [pairs, dcByProduct, delays, classified, dcLocations] = await Promise.all([
      this.repo.loadPairs(run.id),
      this.repo.loadDcStock(),
      this.suppliers.delays(),
      this.classifications.latestStoreClasses(),
      this.repo.dcLocations(),
    ]);
    return {
      run: { id: run.id, historyEnd: run.historyEnd },
      pairs,
      dcByProduct,
      delays,
      classified,
      dcLocations,
    };
  }

  /**
   * "Does this product need anything?" per store, evaluated NOW with the same calculation as
   * generation (current stock, latest forecast, class, supplier delay, DC stock). Writes nothing.
   * DC stock is not shared out between the stores here, unlike in a generation batch.
   */
  async status(productId: string, user: AuthUser): Promise<ProductStatus> {
    const run = await this.forecasts.latestSucceededRun();
    if (!run) return { forecastRunId: null, historyEnd: null, stores: [] };
    const [pairs, dcByProduct, delays, classified, pending] = await Promise.all([
      this.repo.loadPairs(run.id, productId),
      this.repo.loadDcStock(productId),
      this.suppliers.delays(),
      this.classifications.latestStoreClasses(),
      this.repo.pendingForProduct(productId),
    ]);
    const scope = accessibleLocationIds(user);
    const ctx: EvalContext = { delays, classes: classified.classes, historyEnd: run.historyEnd };
    const stores = pairs
      .filter((p) => scope === null || scope.includes(p.locationId))
      .sort((a, b) => a.locationCode.localeCompare(b.locationCode))
      .map((pair) => {
        const e = evaluatePair(pair, dcByProduct.get(productId) ?? [], ctx);
        const o = e.outcome;
        const surplus = 'skip' in o && o.skip === 'NO_NEED' ? storeExcessOf(pair, ctx) : null;
        return {
          locationId: pair.locationId,
          locationCode: pair.locationCode,
          available: e.available,
          inbound: pair.inbound,
          position: e.available + pair.inbound,
          outcome:
            'plan' in o
              ? ('NEEDS_STOCK' as const)
              : surplus
                ? ('EXCESS' as const)
                : o.skip === 'NO_NEED'
                  ? ('NO_ACTION_REQUIRED' as const)
                  : ('NO_SOURCE' as const),
          movableExcess: surplus?.movable ?? null,
          reorderPoint:
            'plan' in o ? o.plan.reorderPoint : o.skip === 'NO_NEED' ? o.reorderPoint : null,
          suggestedQuantity: 'plan' in o ? o.plan.quantity : null,
          suggestedAction: 'plan' in o ? o.plan.action : null,
          serviceLevel: e.serviceLevel,
          cls: e.cls,
          reviewReason: e.review,
          expectedStockoutOn: e.stockout.date,
          stockoutBeyondForecast: e.stockout.beyondForecast,
          outOfStockNow: e.stockout.day === 0,
          isFallback: pair.isFallback,
          pending: pending.get(pair.locationId) ?? null,
        };
      });
    return { forecastRunId: run.id, historyEnd: run.historyEnd, stores };
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

  /** Reword the stored calculation snapshot without sending decision notes or raw free text. */
  async explainInWords(id: string, ctx: RequestContext): Promise<RecommendationWords> {
    const rec = await this.repo.find(id);
    if (!rec) throw notFound();
    assertLocationAccess(ctx.user, rec.locationId);
    const prepared = recommendationWords(rec);
    const result = await this.ai.explain({
      userId: ctx.user.id,
      feature: 'recommendation',
      facts: prepared.facts,
      template: prepared.template,
    });
    return { source: result.source, provider: result.provider, claims: result.answer.claims };
  }

  /**
   * A manager approves: the transfer (already approved) or purchase order is created in the
   * same transaction. Stock still moves only later (dispatch/receive of the transfer, receipt of
   * the order). Approving twice is a 409.
   */
  approve(id: string, body: ApproveBody, ctx: RequestContext): Promise<RecommendationDetail> {
    return this.db.transaction(async (client) => {
      const rec = await this.repo.lock(client, id);
      if (!rec) throw notFound();
      assertPending(rec.status);
      const quantity = approvedQuantity(rec.reviewReason, rec.quantity, body);

      let links: { transferId?: string; purchaseOrderId?: string };
      if (rec.action === 'REDISTRIBUTE_EXCESS' && rec.destinationLocationId) {
        links = {
          transferId: await this.transfers.createApproved(
            client,
            {
              sourceLocationId: rec.locationId,
              destinationLocationId: rec.destinationLocationId,
              notes: `Excess redistribution, recommendation ${id}`,
              lines: [{ productId: rec.productId, quantity }],
            },
            ctx.user.id,
          ),
        };
      } else if (rec.action === 'TRANSFER' && rec.sourceLocationId) {
        links = {
          transferId: await this.transfers.createApproved(
            client,
            {
              sourceLocationId: rec.sourceLocationId,
              destinationLocationId: rec.locationId,
              notes: `Replenishment recommendation ${id}`,
              lines: [{ productId: rec.productId, quantity }],
            },
            ctx.user.id,
          ),
        };
      } else if (rec.supplierId && 'supplier' in rec.inputs && rec.inputs.supplier) {
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
                  quantity,
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
      await this.repo.decide(client, id, 'APPROVED', ctx.user.id, body.note, links, quantity);
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

/**
 * A recommendation flagged for review is approved only with the manager's own quantity and a
 * note; an unflagged one only as suggested (V2 2d-1).
 */
function approvedQuantity(
  review: ReviewReason | null,
  suggested: number,
  body: ApproveBody,
): number {
  if (review) {
    if (body.quantity === undefined || !body.note) {
      throw new UnprocessableEntityException({
        code: 'QUANTITY_REQUIRED',
        message:
          'This recommendation needs a manual review: enter the quantity to approve and a note.',
      });
    }
    return body.quantity;
  }
  if (body.quantity !== undefined && body.quantity !== suggested) {
    throw new UnprocessableEntityException({
      code: 'QUANTITY_NOT_ALLOWED',
      message: 'Only recommendations flagged for review can be approved with another quantity.',
    });
  }
  return suggested;
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
