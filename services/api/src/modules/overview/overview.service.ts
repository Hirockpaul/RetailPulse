import { Injectable } from '@nestjs/common';
import { accessibleLocationIds } from '../../core/auth/access';
import type { AuthUser } from '../../core/auth/auth.types';
import { EventsService } from '../events/events.service';
import { ForecastsService } from '../forecasts/forecasts.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { atRiskWithin, healthByStore, summarizePositions } from './overview.calc';
import { OVERVIEW } from './overview.config';
import { OverviewRepository } from './overview.repository';
import type { LocationHealth, Overview, SupplierRisk } from './overview.schemas';

/** One read for the landing page: risks, surplus, work waiting, and how fresh each number is. */
@Injectable()
export class OverviewService {
  constructor(
    private readonly repo: OverviewRepository,
    private readonly forecasts: ForecastsService,
    private readonly events: EventsService,
    private readonly suppliers: SuppliersService,
  ) {}

  async get(user: AuthUser): Promise<Overview> {
    const scope = accessibleLocationIds(user);
    const asOf = new Date();
    const [run, eventStats] = await Promise.all([
      this.forecasts.latestSucceededRun(),
      this.events.stats(),
    ]);
    const [
      storeCount,
      positions,
      recs,
      alerts,
      lastMovementAt,
      locations,
      risks,
      openOrders,
      supplierStats,
      sales,
    ] = await Promise.all([
      this.repo.storeCount(scope),
      this.repo.positions(
        run?.id ?? null,
        OVERVIEW.riskWindowDays,
        scope,
        OVERVIEW.riskWindowLongDays,
      ),
      this.repo.recommendationCounts(scope),
      this.repo.alertCounts(scope),
      this.repo.lastMovementAt(scope),
      this.repo.locations(scope),
      this.repo.risks(scope, OVERVIEW.transferDelayDays),
      this.repo.openOrdersBySupplier(scope),
      this.suppliers.list(),
      this.repo.salesSeries(
        run?.id ?? null,
        run?.historyEnd ?? null,
        OVERVIEW.salesHistoryDays,
        scope,
      ),
    ]);
    const storeHealth = healthByStore(positions, OVERVIEW);
    const suppliers: SupplierRisk[] = supplierStats.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      score: x.score,
      onTimeRate: x.onTimeRate,
      openPurchaseOrders: openOrders.get(x.id) ?? 0,
    }));
    const sum = (f: (h: (typeof storeHealth)[number]) => number) =>
      storeHealth.reduce((n, h) => n + f(h), 0);
    const excessValue = Math.round(sum((h) => h.excessValue) * 100) / 100;

    return {
      asOf,
      rules: { riskWindowDays: OVERVIEW.riskWindowDays, excessCoverDays: OVERVIEW.excessCoverDays },
      storeCount,
      stock: summarizePositions(positions, OVERVIEW),
      recommendations: {
        pending: recs.pending,
        byRisk: { CRITICAL: recs.critical, HIGH: recs.high },
        byAction: {
          TRANSFER: recs.transfer,
          PURCHASE_ORDER: recs.purchaseOrder,
          REDISTRIBUTE_EXCESS: recs.redistributeExcess,
        },
        lastGeneratedAt: recs.lastGeneratedAt,
      },
      alerts: {
        open: alerts.open,
        byKind: { OUT_OF_STOCK: alerts.outOfStock, LOW_STOCK: alerts.lowStock },
      },
      freshness: {
        lastMovementAt,
        forecast: run
          ? {
              runId: run.id,
              finishedAt: run.finishedAt,
              historyEnd: run.historyEnd,
              dataLabel: run.dataLabel,
              servedModel: run.servedModel,
            }
          : null,
        lastEventProcessedAt: eventStats.events.lastProcessedAt,
        eventsWaiting: eventStats.events.pending + eventStats.events.retrying,
      },
      controlTower: {
        rules: {
          riskWindowLongDays: OVERVIEW.riskWindowLongDays,
          transferDelayDays: OVERVIEW.transferDelayDays,
          supplierRiskScore: OVERVIEW.supplierRiskScore,
        },
        kpis: {
          onHand: locations.reduce((n, l) => n + l.onHand, 0),
          available: locations.reduce((n, l) => n + l.available, 0),
          valueAtCost: Math.round(locations.reduce((n, l) => n + l.valueAtCost, 0) * 100) / 100,
          openTransfers: risks.openTransfers,
          openAnomalies: risks.openAnomalies,
          excessValueAtCost: excessValue,
        },
        risks: {
          atRisk7: atRiskWithin(positions, 'short'),
          atRisk14: atRiskWithin(positions, 'long'),
          excess: {
            positions: sum((h) => h.excess),
            units: sum((h) => h.excessUnits),
            valueAtCost: excessValue,
          },
          delayedTransfers: risks.delayedTransfers,
          overduePurchaseOrders: risks.overduePurchaseOrders,
          openAnomalies: risks.openAnomalies,
          openHighAnomalies: risks.openHighAnomalies,
          suppliersAtRisk: suppliers.filter(
            (x) => x.score !== null && x.score < OVERVIEW.supplierRiskScore,
          ),
        },
        charts: { storeHealth, sales, suppliers },
      },
    };
  }

  /** One row per location in scope: stock, value, open work and (stores) stock health. */
  async locations(user: AuthUser): Promise<LocationHealth[]> {
    const scope = accessibleLocationIds(user);
    const run = await this.forecasts.latestSucceededRun();
    const [rows, positions] = await Promise.all([
      this.repo.locations(scope),
      this.repo.positions(run?.id ?? null, OVERVIEW.riskWindowDays, scope),
    ]);
    const health = new Map(healthByStore(positions, OVERVIEW).map((h) => [h.locationId, h]));
    return rows.map((r) => {
      const h = r.locationType === 'STORE' ? health.get(r.locationId) : undefined;
      return {
        ...r,
        outOfStock: h ? h.outOfStock : r.locationType === 'STORE' ? 0 : null,
        atRisk: h ? h.atRisk : r.locationType === 'STORE' ? 0 : null,
        excess: h ? h.excess : r.locationType === 'STORE' ? 0 : null,
        excessValueAtCost: h ? h.excessValue : r.locationType === 'STORE' ? 0 : null,
      };
    });
  }
}
