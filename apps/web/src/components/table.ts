/** Shared table classes so every data table looks and behaves the same. */
export const table = {
  // relative: keeps absolutely positioned children (sr-only labels) inside the scroll box.
  wrap: 'relative overflow-x-auto rounded-lg border bg-white',
  table: 'min-w-full text-sm',
  thead:
    'border-b bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500',
  th: 'px-3 py-2 font-medium',
  thNum: 'px-3 py-2 text-right font-medium',
  row: 'border-b last:border-0 hover:bg-slate-50',
  td: 'px-3 py-2',
  tdNum: 'px-3 py-2 text-right tabular-nums',
  link: 'whitespace-nowrap font-medium text-sky-700 hover:underline focus:outline-2 focus:outline-sky-500',
  /** A link inside running text: may wrap. */
  textLink: 'font-medium text-sky-700 hover:underline focus:outline-2 focus:outline-sky-500',
};

// max-w-full: a select sizes itself to its longest option; never let it outgrow its container.
export const field =
  'max-w-full rounded border bg-white px-2 py-1.5 text-sm focus:outline-2 focus:outline-sky-500';
