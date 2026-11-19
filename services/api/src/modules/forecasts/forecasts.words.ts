import type { AiAnswer, AiFact } from '../../core/ai/ai.types';
import type { ForecastExplanation } from './forecasts.schemas';

const one = (value: number) => Math.round(value * 10) / 10;
const two = (value: number) => Number(value.toFixed(2));
const numericTokens = (value: string) =>
  value.match(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g) ?? [];

export interface ForecastWordsInput {
  productName: string;
  locationCode: string;
  explanation: NonNullable<ForecastExplanation['explanation']>;
}

export function forecastWords(input: ForecastWordsInput): { facts: AiFact[]; template: AiAnswer } {
  const { explanation: e } = input;
  const forecast = one(e.forecast);
  const startingPoint = one(e.startingPoint);
  const facts: AiFact[] = [
    { id: 'product', label: 'Product name', value: input.productName },
    { id: 'store', label: 'Store code', value: input.locationCode },
    { id: 'target_day', label: 'Forecast day', value: e.targetDay },
    { id: 'forecast', label: 'Forecast units', value: forecast },
    { id: 'starting_point', label: 'Model starting point in units', value: startingPoint },
  ];
  const claims: AiAnswer['claims'] = [
    {
      type: 'prediction',
      text: `${input.productName} at ${input.locationCode} is forecast at ${forecast} units on ${e.targetDay}.`,
    },
  ];

  if (e.range80) {
    facts.push(
      { id: 'range_80_level', label: 'First forecast range level', value: 80 },
      { id: 'range_80_low', label: '80% range lower bound in units', value: one(e.range80.lower) },
      { id: 'range_80_high', label: '80% range upper bound in units', value: one(e.range80.upper) },
    );
    if (e.range80.measuredCoverage !== null) {
      facts.push({
        id: 'range_80_coverage',
        label: 'Measured coverage of the 80% range',
        value: `${one(e.range80.measuredCoverage * 100)}%`,
      });
    }
  }
  if (e.range95) {
    facts.push(
      { id: 'range_95_level', label: 'Second forecast range level', value: 95 },
      { id: 'range_95_low', label: '95% range lower bound in units', value: one(e.range95.lower) },
      { id: 'range_95_high', label: '95% range upper bound in units', value: one(e.range95.upper) },
    );
    if (e.range95.measuredCoverage !== null) {
      facts.push({
        id: 'range_95_coverage',
        label: 'Measured coverage of the 95% range',
        value: `${one(e.range95.measuredCoverage * 100)}%`,
      });
    }
  }

  const rangeSentences: string[] = [];
  if (e.range80) {
    const coverage =
      e.range80.measuredCoverage === null
        ? ''
        : `; in testing it contained ${one(e.range80.measuredCoverage * 100)}% of actual values`;
    rangeSentences.push(
      `The 80% range is ${one(e.range80.lower)} to ${one(e.range80.upper)} units${coverage}.`,
    );
  }
  if (e.range95) {
    const coverage =
      e.range95.measuredCoverage === null
        ? ''
        : `; in testing it contained ${one(e.range95.measuredCoverage * 100)}% of actual values`;
    rangeSentences.push(
      `The wider 95% range is ${one(e.range95.lower)} to ${one(e.range95.upper)} units${coverage}.`,
    );
  }
  if (rangeSentences.length > 0) {
    claims.push({
      type: 'estimate',
      text: `${rangeSentences.join(' ')} These are measured uncertainty ranges, not guarantees.`,
    });
  }

  const strongest = e.factors.slice(0, 3);
  strongest.forEach((factor, index) => {
    const factorNumber = index + 1;
    facts.push({
      id: `factor_${factorNumber}_multiplier`,
      label: `${factor.label} model multiplier`,
      value: two(factor.factor),
    });
    numericTokens(`${factor.label} ${factor.display}`).forEach((value, numberIndex) => {
      facts.push({
        id: `factor_${factorNumber}_number_${numberIndex + 1}`,
        label: `${factor.label} displayed input number`,
        value,
      });
    });
  });
  if (strongest.length > 0) {
    const factorText = strongest
      .map(
        (factor) =>
          `${factor.label} (${factor.display}) multiplied the model forecast by ${two(factor.factor)}`,
      )
      .join('; ');
    claims.push({
      type: 'estimate',
      text: `The model started from ${startingPoint} units. Its strongest displayed factors were: ${factorText}. These describe how the model formed this prediction, not customer behaviour.`,
    });
  }

  return { facts, template: { claims } };
}

export function measuredCoverage(
  ranges: ForecastExplanation['ranges'],
  level: 80 | 95,
  forecast: number,
): number | null {
  const group = ranges.find(
    (range) =>
      range.level === level &&
      forecast >= range.forecastFrom &&
      (range.forecastTo === null || forecast < range.forecastTo),
  );
  return group?.testCoverage ?? null;
}
