import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AiFact, AiToolDefinition, AiToolExecutionResult } from '../../core/ai/ai.types';
import type { AuthUser } from '../../core/auth/auth.types';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { listAnomaliesQuerySchema } from '../anomalies/anomalies.schemas';
import { OverviewService } from '../overview/overview.service';
import { ReplenishmentService } from '../replenishment/replenishment.service';
import {
  RECOMMENDATION_ACTIONS,
  RISKS,
  listRecommendationsQuerySchema,
} from '../replenishment/replenishment.schemas';

const EmptyArguments = z.object({}).strict();
const AnomalyArguments = z.object({ severity: z.enum(['HIGH', 'MEDIUM']).optional() }).strict();
const RecommendationArguments = z
  .object({
    risk: z.enum(RISKS).optional(),
    action: z.enum(RECOMMENDATION_ACTIONS).optional(),
  })
  .strict();

export const ASSISTANT_TOOLS: AiToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_control_tower',
      description:
        'Get current scoped inventory KPIs, stock risks, alerts, recommendations, freshness and store health.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_location_health',
      description:
        'Get current stock and open-work totals for each location the signed-in user may access.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_open_anomalies',
      description: 'Get up to 10 open unusual-activity findings in the signed-in user’s scope.',
      parameters: {
        type: 'object',
        properties: { severity: { type: 'string', enum: ['HIGH', 'MEDIUM'] } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_recommendations',
      description: 'Get up to 10 pending replenishment suggestions in the signed-in user’s scope.',
      parameters: {
        type: 'object',
        properties: {
          risk: { type: 'string', enum: RISKS },
          action: { type: 'string', enum: RECOMMENDATION_ACTIONS },
        },
        additionalProperties: false,
      },
    },
  },
];

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Turn only backend-returned scalar values into evidence for the final numeric check. */
export function factsFromTool(name: string, content: unknown): AiFact[] {
  const facts: AiFact[] = [];
  const visit = (value: unknown, path: string): void => {
    if (value instanceof Date) {
      facts.push({ id: `${name}.${path}`, label: path, value: value.toISOString() });
    } else if (typeof value === 'string' || typeof value === 'number') {
      facts.push({ id: `${name}.${path}`, label: path, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key));
    }
  };
  visit(content, '');
  return facts;
}

@Injectable()
export class AssistantTools {
  constructor(
    private readonly overview: OverviewService,
    private readonly anomalies: AnomaliesService,
    private readonly replenishment: ReplenishmentService,
  ) {}

  async execute(
    name: string,
    argumentsJson: string,
    user: AuthUser,
  ): Promise<AiToolExecutionResult> {
    const raw = parseArguments(argumentsJson);
    let content: unknown;

    if (name === 'get_control_tower') {
      EmptyArguments.parse(raw);
      const value = await this.overview.get(user);
      const position = (row: (typeof value.stock.atRiskTop)[number]) => ({
        sku: row.sku,
        productName: row.productName,
        locationCode: row.locationCode,
        available: row.available,
        inbound: row.inbound,
        demandWindow: row.demandWindow,
        daysOfCover: row.daysOfCover,
        excessUnits: row.excessUnits,
      });
      content = {
        asOf: value.asOf,
        storeCount: value.storeCount,
        stock: {
          ...value.stock,
          atRiskTop: value.stock.atRiskTop.map(position),
          excessTop: value.stock.excessTop.map(position),
        },
        recommendations: value.recommendations,
        alerts: value.alerts,
        freshness: {
          lastMovementAt: value.freshness.lastMovementAt,
          forecastFinishedAt: value.freshness.forecast?.finishedAt ?? null,
          forecastHistoryEnd: value.freshness.forecast?.historyEnd ?? null,
          eventsWaiting: value.freshness.eventsWaiting,
        },
        kpis: value.controlTower.kpis,
        risks: {
          ...value.controlTower.risks,
          suppliersAtRisk: value.controlTower.risks.suppliersAtRisk.map((supplier) => ({
            code: supplier.code,
            name: supplier.name,
            score: supplier.score,
            onTimeRate: supplier.onTimeRate,
            openPurchaseOrders: supplier.openPurchaseOrders,
          })),
        },
        storeHealth: value.controlTower.charts.storeHealth.map((row) => ({
          locationCode: row.locationCode,
          outOfStock: row.outOfStock,
          noForecast: row.noForecast,
          atRisk: row.atRisk,
          excess: row.excess,
          healthy: row.healthy,
          excessUnits: row.excessUnits,
          excessValue: row.excessValue,
        })),
      };
    } else if (name === 'get_location_health') {
      EmptyArguments.parse(raw);
      const rows = await this.overview.locations(user);
      content = rows.map((row) => ({
        locationCode: row.locationCode,
        locationName: row.locationName,
        locationType: row.locationType,
        onHand: row.onHand,
        available: row.available,
        valueAtCost: row.valueAtCost,
        pendingRecommendations: row.pendingRecommendations,
        openAlerts: row.openAlerts,
        openAnomalies: row.openAnomalies,
        transfersIn: row.transfersIn,
        transfersOut: row.transfersOut,
        outOfStock: row.outOfStock,
        atRisk: row.atRisk,
        excess: row.excess,
        excessValueAtCost: row.excessValueAtCost,
      }));
    } else if (name === 'get_open_anomalies') {
      const args = AnomalyArguments.parse(raw);
      const page = await this.anomalies.list(
        listAnomaliesQuerySchema.parse({
          page: 1,
          pageSize: 10,
          status: 'OPEN',
          severity: args.severity,
        }),
        user,
      );
      content = {
        total: page.total,
        findings: page.data.map((finding) => ({
          source: finding.source,
          kind: finding.kind,
          severity: finding.severity,
          status: finding.status,
          day: finding.day,
          sku: finding.sku,
          productName: finding.productName,
          locationCode: finding.locationCode,
          score: finding.score,
          observed: finding.observed,
          expected: finding.expected,
        })),
      };
    } else if (name === 'get_pending_recommendations') {
      const args = RecommendationArguments.parse(raw);
      const page = await this.replenishment.list(
        listRecommendationsQuerySchema.parse({
          page: 1,
          pageSize: 10,
          status: 'PENDING',
          risk: args.risk,
          action: args.action,
        }),
        user,
      );
      content = {
        total: page.total,
        recommendations: page.data.map((recommendation) => ({
          action: recommendation.action,
          quantity: recommendation.quantity,
          risk: recommendation.risk,
          daysOfCover: recommendation.daysOfCover,
          expectedStockoutOn: recommendation.expectedStockoutOn,
          reviewReason: recommendation.reviewReason,
          generatedAt: recommendation.generatedAt,
          sku: recommendation.sku,
          productName: recommendation.productName,
          packSize: recommendation.packSize,
          locationCode: recommendation.locationCode,
          sourceCode: recommendation.sourceCode,
          supplierName: recommendation.supplierName,
          destinationCode: recommendation.destinationCode,
        })),
      };
    } else {
      throw new Error('unknown_tool');
    }

    return { content, facts: factsFromTool(name, content) };
  }
}
