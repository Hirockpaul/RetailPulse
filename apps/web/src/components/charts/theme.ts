/**
 * Chart colours (V2 4a-2), from the dataviz skill's reference palette, validated with its
 * validate_palette.js against the light surface. Light theme only, like the rest of the app.
 *   series: categorical slots 1-2 (blue, orange) — all checks pass.
 *   state: critical / at-risk / good / excess — passes the hard gates; at-risk uses the
 *   categorical yellow because the status warning step fails the lightness band. Its CVD warning
 *   (6.3 vs green) and contrast warning (2.1:1) are covered by 2 px gaps, in-segment counts,
 *   the legend and the table view.
 */
export const CHART = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  inkMuted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series1: '#2a78d6',
  series2: '#eb6834',
  state: {
    outOfStock: '#d03b3b',
    atRisk: '#eda100',
    healthy: '#0ca30c',
    excess: '#3987e5',
    noForecast: '#c3c2b7',
  },
} as const;

/** Text colour inside a filled segment: near-black on yellow and grey, white elsewhere. */
export const inkOn = (fill: string) =>
  fill === CHART.state.atRisk || fill === CHART.state.noForecast ? CHART.ink : '#ffffff';
