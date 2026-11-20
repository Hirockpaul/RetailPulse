import { useEffect, useRef, useState } from 'react';
import type { Route } from '../lib/router';

export interface NavLink {
  label: string;
  to: string;
  active: (r: Route) => boolean;
  /** Hidden from store managers (a UI hint; the API refuses them anyway). */
  networkOnly?: boolean;
}

export type NavEntry = NavLink | { label: string; items: NavLink[] };

const isGroup = (e: NavEntry): e is { label: string; items: NavLink[] } => 'items' in e;

const itemClass = (active: boolean) =>
  `rounded px-3 py-1.5 text-sm focus:outline-2 focus:outline-sky-500 ${
    active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
  }`;

/**
 * Main navigation (V2 4a-2): a few top-level entries, some of them disclosure menus. A menu
 * closes on Escape (focus returns to its button), on a click outside, and when the page changes.
 */
export function MainNav({ entries, route }: { entries: NavEntry[]; route: Route }) {
  // The open menu remembers the page it was opened on: navigating closes it (derived, no effect).
  const routeKey = JSON.stringify(route);
  const [openState, setOpenState] = useState<{
    label: string;
    on: string;
    alignRight: boolean;
  } | null>(null);
  const open = openState && openState.on === routeKey ? openState.label : null;
  /** Opens leftwards when a menu (13 rem) would not fit to the right of its button. */
  const toggle = (label: string, button: HTMLButtonElement) => {
    if (open === label) return setOpenState(null);
    const fitsRight = button.getBoundingClientRect().left + 13 * 16 + 8 <= window.innerWidth;
    setOpenState({ label, on: routeKey, alignRight: !fitsRight });
  };
  const navRef = useRef<HTMLElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenState(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        buttons.current[open]?.focus();
        setOpenState(null);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <nav ref={navRef} aria-label="Main" className="flex flex-wrap gap-1">
      {entries.map((entry) => {
        if (!isGroup(entry)) {
          const active = entry.active(route);
          return (
            <a
              key={entry.label}
              href={entry.to}
              aria-current={active ? 'page' : undefined}
              className={itemClass(active)}
            >
              {entry.label}
            </a>
          );
        }
        const id = `nav-${entry.label.toLowerCase()}`;
        const containsActive = entry.items.some((i) => i.active(route));
        const expanded = open === entry.label;
        const alignRight = expanded && openState?.alignRight;
        return (
          <div key={entry.label} className="relative">
            <button
              type="button"
              ref={(el) => {
                buttons.current[entry.label] = el;
              }}
              aria-expanded={expanded}
              aria-controls={id}
              onClick={(e) => toggle(entry.label, e.currentTarget)}
              className={`${itemClass(containsActive)} flex items-center gap-1`}
            >
              {entry.label}
              <span aria-hidden="true" className="text-xs">
                ▾
              </span>
            </button>
            {expanded && (
              <ul
                id={id}
                className={`absolute z-20 mt-1 w-52 max-w-[calc(100vw-2rem)] space-y-0.5 rounded-lg border bg-card p-1 shadow-lg ${
                  alignRight ? 'right-0' : 'left-0'
                }`}
              >
                {entry.items.map((item) => {
                  const active = item.active(route);
                  return (
                    <li key={item.label}>
                      <a
                        href={item.to}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setOpenState(null)}
                        className={`block ${itemClass(active)}`}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
