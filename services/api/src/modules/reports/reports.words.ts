import type { AiAnswer, AiFact } from '../../core/ai/ai.types';
import type { ReportContent } from './reports.schemas';

const two = (value: number) => Number(value.toFixed(2));

/** Select the small, display-ready subset of a frozen report that may leave the server. */
export function reportWords(content: ReportContent): { facts: AiFact[]; template: AiAnswer } {
  const scope = content.scope ? `${content.scope.code} — ${content.scope.name}` : 'Whole network';
  const facts: AiFact[] = [
    { id: 'kind', label: 'Report kind', value: content.kind },
    { id: 'period_start', label: 'Period start (UTC)', value: content.periodStart },
    { id: 'period_end', label: 'Period end (UTC)', value: content.periodEnd },
    { id: 'scope', label: 'Report scope', value: scope },
    { id: 'units_sold', label: 'Units sold', value: content.sales.unitsSold },
    { id: 'units_returned', label: 'Units returned', value: content.sales.unitsReturned },
    {
      id: 'sales_value',
      label: 'Sales value at prices when the report was generated',
      value: two(content.sales.salesValueAtPrice),
    },
    { id: 'receipts', label: 'Units received', value: content.movements.receipts },
    { id: 'transfers_in', label: 'Units transferred in', value: content.movements.transfersIn },
    { id: 'transfers_out', label: 'Units transferred out', value: content.movements.transfersOut },
    {
      id: 'adjustments_net',
      label: 'Net stock adjustment units',
      value: content.movements.adjustmentsNet,
    },
    {
      id: 'recommendations',
      label: 'Recommendations generated',
      value: content.work.recommendationsGenerated,
    },
    { id: 'alerts', label: 'Alerts opened', value: content.work.alertsOpened },
    { id: 'anomalies', label: 'Anomalies found', value: content.work.anomaliesFound },
    { id: 'stock_as_of', label: 'Stock snapshot time', value: content.stockAtGeneration.asOf },
    {
      id: 'on_hand',
      label: 'Units on hand at generation',
      value: content.stockAtGeneration.onHand,
    },
    {
      id: 'available',
      label: 'Units available at generation',
      value: content.stockAtGeneration.available,
    },
    {
      id: 'positions',
      label: 'Stock positions at generation',
      value: content.stockAtGeneration.positions,
    },
    {
      id: 'out_of_stock',
      label: 'Out-of-stock positions at generation',
      value: content.stockAtGeneration.outOfStock,
    },
  ];

  const claims: AiAnswer['claims'] = [
    {
      type: 'fact',
      text: `This ${content.kind.toLowerCase()} report covers ${content.periodStart} to ${content.periodEnd} for ${scope}. It records ${content.sales.unitsSold} units sold, ${content.sales.unitsReturned} units returned, and a sales value of ${two(content.sales.salesValueAtPrice)} at the prices used when the report was generated.`,
    },
    {
      type: 'fact',
      text: `Stock movements in the period included ${content.movements.receipts} units received, ${content.movements.transfersIn} transferred in, ${content.movements.transfersOut} transferred out, and a net adjustment of ${content.movements.adjustmentsNet} units.`,
    },
    {
      type: 'fact',
      text: `The period produced ${content.work.recommendationsGenerated} replenishment recommendations, ${content.work.alertsOpened} alerts, and ${content.work.anomaliesFound} anomaly findings. These counts describe recorded work; they do not decide what action to take.`,
    },
    {
      type: 'fact',
      text: `At the ${content.stockAtGeneration.asOf} generation-time snapshot, ${content.stockAtGeneration.onHand} units were on hand and ${content.stockAtGeneration.available} were available across ${content.stockAtGeneration.positions} positions; ${content.stockAtGeneration.outOfStock} positions were out of stock. These are generation-time figures, not period-end figures.`,
    },
  ];

  content.sales.byStore.slice(0, 3).forEach((store, index) => {
    facts.push(
      {
        id: `store_${index + 1}_code`,
        label: `Leading store ${index + 1} code`,
        value: store.code,
      },
      {
        id: `store_${index + 1}_units`,
        label: `Leading store ${index + 1} units sold`,
        value: store.unitsSold,
      },
    );
  });
  const leadingStore = content.sales.byStore[0];
  if (leadingStore) {
    claims.push({
      type: 'fact',
      text: `${leadingStore.code} recorded the most units sold in the report's store breakdown, with ${leadingStore.unitsSold}.`,
    });
  }

  content.sales.topProducts.slice(0, 3).forEach((product, index) => {
    facts.push(
      {
        id: `product_${index + 1}_sku`,
        label: `Leading product ${index + 1} SKU`,
        value: product.sku,
      },
      {
        id: `product_${index + 1}_name`,
        label: `Leading product ${index + 1} name`,
        value: product.name,
      },
      {
        id: `product_${index + 1}_units`,
        label: `Leading product ${index + 1} units sold`,
        value: product.unitsSold,
      },
    );
  });
  const leadingProduct = content.sales.topProducts[0];
  if (leadingProduct) {
    claims.push({
      type: 'fact',
      text: `${leadingProduct.sku} — ${leadingProduct.name} led the product breakdown with ${leadingProduct.unitsSold} units sold.`,
    });
  }

  const { atRisk7, atRisk14, excessPositions } = content.stockAtGeneration;
  if (atRisk7 !== null && atRisk14 !== null && excessPositions !== null) {
    facts.push(
      { id: 'risk_horizon_short', label: 'Short stock-risk horizon in days', value: 7 },
      { id: 'risk_horizon_long', label: 'Long stock-risk horizon in days', value: 14 },
      { id: 'at_risk_7', label: 'Positions forecast to run out within 7 days', value: atRisk7 },
      { id: 'at_risk_14', label: 'Positions forecast to run out within 14 days', value: atRisk14 },
      { id: 'excess_positions', label: 'Positions estimated as excess', value: excessPositions },
    );
    claims.push({
      type: 'prediction',
      text: `The generation-time forecast flagged ${atRisk7} positions at risk within 7 days and ${atRisk14} within 14 days, while ${excessPositions} positions were estimated as excess. These are forecast-based signals and actual outcomes may differ.`,
    });
  } else {
    claims.push({
      type: 'unknown',
      text: 'Forecast-based stock risk and excess figures were not available for this report.',
    });
  }

  return { facts, template: { claims } };
}
