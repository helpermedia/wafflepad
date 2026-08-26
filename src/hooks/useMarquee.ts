import { useEffect, useRef } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";

/** Travel before a press becomes a marquee: the same 5px that separates
 *  a click from a drag elsewhere in the host */
const MARQUEE_THRESHOLD = 5;

interface UseMarqueeOptions {
  /** Whether a background press may start a marquee */
  enabled: boolean;
  /** The selection when the marquee starts: an additive marquee (Shift or
   *  Cmd held) adds to it, a plain one replaces it, a cancel restores it */
  getBase: () => string[];
  /** Reports the selection the marquee implies whenever it changes */
  onSelect: (ids: string[]) => void;
  /** A marquee that had started selecting was released: the button that
   *  drew it (0 left, 2 right) and the selection it left */
  onEnd?: (button: number, ids: string[]) => void;
}

interface Tile {
  id: string;
  rect: DOMRect;
}

interface Session {
  startX: number;
  startY: number;
  button: number;
  additive: boolean;
  base: string[];
  /** Past the threshold: the rectangle shows and selects */
  active: boolean;
  /** The visible tiles, measured once: geometry cannot change under a
   *  marquee (no drag, no reorder), it can only scroll away, which drops
   *  the snapshot for the next move to retake */
  tiles: Tile[] | null;
  lastKey: string | null;
  lastIds: string[];
  detach: () => void;
}

/**
 * Finder-style rubber-band selection: a press on empty background that
 * travels becomes a rectangle, and every tile it touches is selected.
 * Either button draws one; a right-button marquee lets the host act on
 * the result as soon as it is released (onEnd). The rectangle is
 * positioned directly on its element (a state update per mouse move
 * would re-render the whole grid); only the selection is React state,
 * and it only updates when the set of touched tiles changes.
 */
export function useMarquee({ enabled, getBase, onSelect, onEnd }: UseMarqueeOptions) {
  /** The rectangle element: fixed, hidden until a marquee is active */
  const rectRef = useRef<HTMLDivElement>(null);
  /** The subtree whose tiles are candidates */
  const scopeRef = useRef<HTMLDivElement>(null);
  const optionsRef = useLatestRef({ enabled, getBase, onSelect, onEnd });
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    const sessions = sessionRef;
    return () => sessions.current?.detach();
  }, []);

  function measureTiles(): Tile[] {
    const scope = scopeRef.current;
    if (!scope) return [];
    const tiles: Tile[] = [];
    for (const el of scope.querySelectorAll<HTMLElement>("[data-grid-item][data-id]")) {
      // A hidden layout (display:none) keeps its tiles in the DOM
      if (!(el.checkVisibility?.() ?? el.offsetParent !== null)) continue;
      const id = el.dataset.id;
      if (id) tiles.push({ id, rect: el.getBoundingClientRect() });
    }
    return tiles;
  }

  function hitIds(tiles: Tile[], left: number, top: number, right: number, bottom: number) {
    return tiles
      .filter(({ rect: r }) => r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom)
      .map((tile) => tile.id);
  }

  function endSession() {
    const session = sessionRef.current;
    if (!session) return;
    session.detach();
    sessionRef.current = null;
    const rect = rectRef.current;
    if (rect) rect.hidden = true;
  }

  /** Attach to the host's root mousedown: starts a session on a press
   *  that lands on empty background */
  function onMouseDown(e: React.MouseEvent) {
    if ((e.button !== 0 && e.button !== 2) || !optionsRef.current.enabled || sessionRef.current) {
      return;
    }
    const target = e.target as HTMLElement;
    // Tiles belong to the drag engines, controls to themselves
    if (target.closest("[data-grid-item], [data-keep-open], input, button")) return;

    const session: Session = {
      startX: e.clientX,
      startY: e.clientY,
      button: e.button,
      additive: e.shiftKey || e.metaKey,
      base: optionsRef.current.getBase(),
      active: false,
      tiles: null,
      lastKey: null,
      lastIds: [],
      detach: () => {},
    };

    function onMove(ev: MouseEvent) {
      if (!session.active) {
        if (Math.hypot(ev.clientX - session.startX, ev.clientY - session.startY) <= MARQUEE_THRESHOLD) {
          return;
        }
        session.active = true;
      }
      const left = Math.min(session.startX, ev.clientX);
      const top = Math.min(session.startY, ev.clientY);
      const right = Math.max(session.startX, ev.clientX);
      const bottom = Math.max(session.startY, ev.clientY);

      // Reads before writes: measuring after the rectangle's style writes
      // would force a reflow on every move
      session.tiles ??= measureTiles();
      const hits = hitIds(session.tiles, left, top, right, bottom);

      const rect = rectRef.current;
      if (rect) {
        rect.hidden = false;
        rect.style.left = `${left}px`;
        rect.style.top = `${top}px`;
        rect.style.width = `${right - left}px`;
        rect.style.height = `${bottom - top}px`;
      }

      const ids = session.additive ? [...new Set([...session.base, ...hits])] : hits;
      session.lastIds = ids;
      const key = ids.join("\n");
      if (key === session.lastKey) return;
      session.lastKey = key;
      optionsRef.current.onSelect(ids);
    }

    function onUp(ev: MouseEvent) {
      // Only the button that drew the marquee ends it
      if (ev.button !== session.button) return;
      const wasActive = session.active;
      endSession();
      if (wasActive) optionsRef.current.onEnd?.(session.button, session.lastIds);
    }

    function onScroll() {
      session.tiles = null;
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("scroll", onScroll, true);
    session.detach = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("scroll", onScroll, true);
    };
    sessionRef.current = session;
  }

  /** Whether a right-button press is being tracked: the host must then
   *  suppress the context menu, which macOS opens on the press itself,
   *  before the press can be told from a drag */
  function isRightButtonPress(): boolean {
    return sessionRef.current?.button === 2;
  }

  /** Escape: abandon an active marquee and restore the selection it
   *  started from. Returns whether there was one to cancel. */
  function cancel(): boolean {
    const session = sessionRef.current;
    if (!session) return false;
    const wasActive = session.active;
    endSession();
    if (wasActive) optionsRef.current.onSelect(session.base);
    return wasActive;
  }

  return { rectRef, scopeRef, onMouseDown, isRightButtonPress, cancel };
}
