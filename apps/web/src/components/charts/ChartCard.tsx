import type { ReactNode } from 'react';
import { table } from '../table';

export interface LegendItem {
  label: string;
  color: string;
  kind: 'rect' | 'line';
}

/**
 * A chart with its title, legend (two or more series), the chart itself and a "Show as table"
 * view, so no value is reachable only by hovering.
 */
export function ChartCard(props: {
  title: string;
  subtitle?: string;
  legend?: LegendItem[];
  children: ReactNode;
  tableHead: string[];
  tableRows: (string | number)[][];
  /** Column indexes to right-align (numbers). */
  numeric?: number[];
}) {
  return (
    <section className="min-w-0 space-y-3 rounded-lg border bg-white p-4">
      <div>
        <h4 className="font-medium">{props.title}</h4>
        {props.subtitle && <p className="text-xs text-slate-500">{props.subtitle}</p>}
      </div>
      {props.legend && props.legend.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legend">
          {props.legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={
                  l.kind === 'line'
                    ? 'inline-block h-0.5 w-4'
                    : 'inline-block h-2.5 w-2.5 rounded-sm'
                }
                style={{ backgroundColor: l.color }}
              />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      {props.children}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
          Show as table
        </summary>
        <div className={`${table.wrap} mt-2`}>
          <table className={table.table}>
            <thead className={table.thead}>
              <tr>
                {props.tableHead.map((h, i) => (
                  <th key={h} className={props.numeric?.includes(i) ? table.thNum : table.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.tableRows.map((r) => (
                <tr key={String(r[0])} className={table.row}>
                  {r.map((c, i) => (
                    <td key={i} className={props.numeric?.includes(i) ? table.tdNum : table.td}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
