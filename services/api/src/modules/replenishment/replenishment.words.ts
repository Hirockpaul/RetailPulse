import type { AiAnswer, AiFact } from '../../core/ai/ai.types';
import type { ExcessInputs, NeedInputs, RecommendationDetail } from './replenishment.schemas';

const one = (value: number) => Math.round(value * 10) / 10;
const pct = (value: number) => `${one(value * 100)}%`;

function commonFacts(rec: RecommendationDetail): AiFact[] {
  return [
    { id: 'product', label: 'Product name', value: rec.productName },
    { id: 'store', label: 'Store code', value: rec.locationCode },
    { id: 'action', label: 'Suggested action', value: rec.action },
    { id: 'quantity', label: 'Suggested quantity in units', value: rec.quantity },
    { id: 'pack_size', label: 'Pack size in units', value: rec.packSize },
  ];
}

function needWords(
  rec: RecommendationDetail,
  inputs: NeedInputs,
): { facts: AiFact[]; template: AiAnswer } {
  const facts = commonFacts(rec);
  const { forecast, parameters, stock, calculation } = inputs;
  facts.push(
    { id: 'on_hand', label: 'Units on hand', value: stock.onHand },
    { id: 'reserved', label: 'Reserved units', value: stock.reserved },
    { id: 'available', label: 'Available units', value: stock.available },
    { id: 'inbound', label: 'Inbound units', value: stock.inbound },
    { id: 'position', label: 'Inventory position', value: stock.position },
    {
      id: 'avg_daily_demand',
      label: 'Forecast average units per day',
      value: one(forecast.avgDailyDemand),
    },
    {
      id: 'lead_time_demand',
      label: 'Forecast demand during lead time',
      value: one(forecast.demandDuringLead),
    },
    {
      id: 'cover_demand',
      label: 'Forecast demand through lead and review periods',
      value: one(forecast.demandDuringCover),
    },
    { id: 'lead_time', label: 'Lead time in days', value: one(parameters.leadTimeDays) },
    { id: 'review_period', label: 'Review period in days', value: parameters.reviewPeriodDays },
    { id: 'safety_stock', label: 'Safety stock in units', value: one(calculation.safetyStock) },
    { id: 'reorder_point', label: 'Reorder point in units', value: one(calculation.reorderPoint) },
    { id: 'order_up_to', label: 'Order-up-to level in units', value: one(calculation.orderUpTo) },
    { id: 'raw_quantity', label: 'Unrounded need in units', value: one(calculation.rawQuantity) },
  );
  if (forecast.sigmaError !== undefined) {
    facts.push({
      id: 'forecast_error',
      label: 'Typical daily forecast error in units',
      value: one(forecast.sigmaError),
    });
  }
  if (parameters.serviceLevel !== undefined) {
    facts.push({
      id: 'service_level',
      label: 'Target service level',
      value: pct(parameters.serviceLevel),
    });
  }
  if (parameters.minOrderQty !== null) {
    facts.push({
      id: 'minimum_order',
      label: 'Supplier minimum order in units',
      value: parameters.minOrderQty,
    });
  }

  const claims: AiAnswer['claims'] = [
    {
      type: 'fact',
      text: `${rec.productName} at ${rec.locationCode} has ${stock.onHand} units on hand, ${stock.reserved} reserved, and ${stock.inbound} inbound. That gives ${stock.available} available and an inventory position of ${stock.position}.`,
    },
    {
      type: 'prediction',
      text: `The forecast averages ${one(forecast.avgDailyDemand)} units per day and predicts ${one(forecast.demandDuringLead)} units of demand during the ${one(parameters.leadTimeDays)}-day lead time.`,
    },
    {
      type: 'estimate',
      text: `The calculation adds ${one(calculation.safetyStock)} units of safety stock, giving a reorder point of ${one(calculation.reorderPoint)} units and an order-up-to level of ${one(calculation.orderUpTo)} units.`,
    },
    {
      type: 'recommendation',
      text: `The unrounded need is ${one(calculation.rawQuantity)} units. RetailPulse suggests ${rec.quantity} units after applying the pack size of ${rec.packSize}. This is a suggestion for a manager to decide, not an order.`,
    },
  ];

  if (rec.action === 'TRANSFER' && inputs.source) {
    facts.push(
      { id: 'source_code', label: 'Transfer source code', value: inputs.source.code },
      {
        id: 'source_available',
        label: 'Net units available at transfer source',
        value: inputs.source.availableNet,
      },
    );
    claims.push({
      type: 'recommendation',
      text: `A transfer from ${inputs.source.code} is suggested because that source has ${inputs.source.availableNet} net units available for the ${rec.quantity}-unit suggestion.`,
    });
  } else if (rec.action === 'PURCHASE_ORDER' && inputs.supplier) {
    facts.push(
      { id: 'supplier', label: 'Supplier name', value: inputs.supplier.name },
      {
        id: 'supplier_lead_time',
        label: 'Supplier promised lead time in days',
        value: inputs.supplier.leadTimeDays,
      },
      {
        id: 'supplier_minimum',
        label: 'Supplier minimum order in units',
        value: inputs.supplier.minOrderQty,
      },
    );
    if (inputs.dcShortfall) {
      facts.push(
        {
          id: 'short_dc',
          label: 'Distribution centre code with insufficient stock',
          value: inputs.dcShortfall.code,
        },
        {
          id: 'short_dc_available',
          label: 'Net units available at that distribution centre',
          value: inputs.dcShortfall.availableNet,
        },
        {
          id: 'short_dc_needed',
          label: 'Units needed from that distribution centre',
          value: inputs.dcShortfall.needed,
        },
      );
    }
    const shortfall = inputs.dcShortfall
      ? ` ${inputs.dcShortfall.code} had ${inputs.dcShortfall.availableNet} net units while ${inputs.dcShortfall.needed} were needed.`
      : '';
    claims.push({
      type: 'recommendation',
      text: `A purchase order from ${inputs.supplier.name} is suggested because no eligible transfer source covered the need. The supplier has a ${inputs.supplier.leadTimeDays}-day promised lead time and a minimum of ${inputs.supplier.minOrderQty} units.${shortfall}`,
    });
  }

  if (rec.reviewReason) {
    facts.push({ id: 'review_reason', label: 'Manual review reason', value: rec.reviewReason });
    claims.push({
      type: 'unknown',
      text: 'This suggestion is flagged for manual review because its quantity is less trustworthy. A manager must choose the final quantity and record why.',
    });
  }

  return { facts, template: { claims } };
}

function excessWords(
  rec: RecommendationDetail,
  inputs: ExcessInputs,
): { facts: AiFact[]; template: AiAnswer } {
  const facts = commonFacts(rec);
  facts.push(
    { id: 'available', label: 'Available units', value: inputs.stock.available },
    { id: 'inbound', label: 'Inbound units', value: inputs.stock.inbound },
    { id: 'position', label: 'Inventory position', value: inputs.stock.position },
    {
      id: 'promised_out',
      label: 'Units promised to outgoing transfers',
      value: inputs.stock.promisedOut,
    },
    { id: 'keep_days', label: 'Days of forecast demand to keep', value: inputs.excess.keepDays },
    {
      id: 'keep_demand',
      label: 'Forecast demand over keep period',
      value: one(inputs.excess.demandKeep),
    },
    {
      id: 'reorder_point',
      label: 'Reorder point in units',
      value: one(inputs.excess.reorderPoint),
    },
    { id: 'keep_units', label: 'Units to keep', value: one(inputs.excess.keep) },
    { id: 'excess_units', label: 'Units above the keep level', value: one(inputs.excess.excess) },
    { id: 'movable_units', label: 'Movable excess in whole packs', value: inputs.excess.movable },
    { id: 'destination', label: 'Transfer destination code', value: inputs.destination.code },
    {
      id: 'destination_available',
      label: 'Destination available units before transfer',
      value: inputs.destination.available,
    },
  );

  return {
    facts,
    template: {
      claims: [
        {
          type: 'fact',
          text: `${rec.productName} at ${rec.locationCode} has ${inputs.stock.available} available units, ${inputs.stock.inbound} inbound, and ${inputs.stock.promisedOut} already promised to outgoing transfers. Its inventory position is ${inputs.stock.position}.`,
        },
        {
          type: 'prediction',
          text: `The keep level covers ${inputs.excess.keepDays} days and ${one(inputs.excess.demandKeep)} forecast units of demand. The calculation keeps ${one(inputs.excess.keep)} units, including the ${one(inputs.excess.reorderPoint)}-unit reorder point.`,
        },
        {
          type: 'estimate',
          text: `${one(inputs.excess.excess)} units are above the keep level; ${inputs.excess.movable} units are movable after pack rounding and existing commitments.`,
        },
        {
          type: 'recommendation',
          text: `RetailPulse suggests transferring ${rec.quantity} units to ${inputs.destination.code}, which had ${inputs.destination.available} available units before this suggestion. This rebalances existing stock and does not create a supplier order.`,
        },
      ],
    },
  };
}

export function recommendationWords(rec: RecommendationDetail): {
  facts: AiFact[];
  template: AiAnswer;
} {
  return rec.inputs.kind === 'EXCESS' ? excessWords(rec, rec.inputs) : needWords(rec, rec.inputs);
}
