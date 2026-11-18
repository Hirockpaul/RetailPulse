import { type ReactNode, useCallback, useState } from 'react';

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/**
 * One tooltip per chart: marks call `show` on pointer move and keyboard focus, `hide` on leave
 * and blur. Content is React nodes (never HTML strings). Fixed-positioned at the pointer (or above
 * the focused mark) and kept inside the window, so it never causes horizontal scrolling.
 */
export function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);

  const showAt = useCallback(
    (clientX: number, clientY: number, content: ReactNode) =>
      setTip({ x: clientX, y: clientY, content }),
    [],
  );

  /** For keyboard focus: place the tooltip above the focused element. */
  const showFor = useCallback(
    (el: Element, content: ReactNode) => {
      const r = el.getBoundingClientRect();
      showAt(r.left + r.width / 2, r.top, content);
    },
    [showAt],
  );

  const hide = useCallback(() => setTip(null), []);

  const layer = tip ? (
    <div
      role="status"
      className="pointer-events-none fixed z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border bg-white px-2 py-1 text-xs shadow"
      style={{
        left: Math.min(Math.max(tip.x, 110), window.innerWidth - 110),
        top: tip.y - 8,
      }}
    >
      {tip.content}
    </div>
  ) : null;

  return { showAt, showFor, hide, layer };
}
