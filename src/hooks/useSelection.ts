import { useEffect, useState } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";

interface UseSelectionOptions {
  /** Top-level grid ids in grid order. The selection is pruned against
   *  them every render, so an item that leaves the grid (dragged into a
   *  folder, pinned away) leaves the selection with it */
  itemIds: string[];
  /** The selection clears whenever this changes (a search query) */
  resetKey: unknown;
  /** Whether the keyboard shortcuts are live (no folder open, no rename,
   *  no drag, not closing) */
  enabled: boolean;
  /** Cmd+A selects every item, unless the search field has text, which
   *  it must keep selecting */
  canSelectAll: boolean;
  /** Ctrl+Cmd+N with two or more items selected (Finder's shortcut) */
  onNewFolder: () => void;
}

interface SelectionState {
  resetKey: unknown;
  /** Selected ids in the order they were selected; grid order is derived */
  ids: string[];
  /** Where a Shift-click range starts: the last item clicked in */
  anchorId: string | null;
}

const ARROW_KEYS = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];

/**
 * Finder-style multi-selection over the top-level grid: Cmd-click toggles
 * an item, Shift-click extends a range from the anchor, a marquee or
 * Cmd+A replaces the set. Ids only, the tiles render the highlight. A
 * multi-selection and the keyboard cursor never show together: the host
 * disables keyboard navigation while a selection exists, and an arrow
 * key clears the selection so the cursor returns.
 */
export function useSelection({
  itemIds,
  resetKey,
  enabled,
  canSelectAll,
  onNewFolder,
}: UseSelectionOptions) {
  const [state, setState] = useState<SelectionState>({ resetKey, ids: [], anchorId: null });

  // setState during render: React retries before commit, so no stale frame
  if (state.resetKey !== resetKey) {
    setState({ resetKey, ids: [], anchorId: null });
  }

  const live = new Set(itemIds);
  const ids = new Set(state.ids.filter((id) => live.has(id)));
  /** The selection in grid order */
  const ordered = itemIds.filter((id) => ids.has(id));

  /** Cmd-click: in or out, and the range anchor moves here */
  function toggle(id: string) {
    setState((s) => ({
      ...s,
      ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
      anchorId: id,
    }));
  }

  /** Shift-click: everything between the anchor and here joins */
  function extendTo(id: string) {
    setState((s) => {
      const anchor = s.anchorId !== null && live.has(s.anchorId) ? s.anchorId : id;
      const a = itemIds.indexOf(anchor);
      const b = itemIds.indexOf(id);
      if (a === -1 || b === -1) return s;
      const range = itemIds.slice(Math.min(a, b), Math.max(a, b) + 1);
      return { ...s, ids: [...new Set([...s.ids, ...range])], anchorId: anchor };
    });
  }

  /** A marquee's result; a Shift-click afterwards extends from its first
   *  item, not from whatever was clicked before it */
  function replace(next: string[]) {
    setState((s) => ({ ...s, ids: next, anchorId: next[0] ?? null }));
  }

  function clear() {
    setState((s) => (s.ids.length === 0 ? s : { ...s, ids: [], anchorId: null }));
  }

  const stateRef = useLatestRef({ itemIds, enabled, canSelectAll, size: ids.size, onNewFolder });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const { itemIds, enabled, canSelectAll, size, onNewFolder } = stateRef.current;
      if (!enabled || e.isComposing) return;
      if (e.metaKey && e.ctrlKey && !e.altKey && e.code === "KeyN") {
        if (size >= 2) {
          e.preventDefault();
          onNewFolder();
        }
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyA") {
        if (canSelectAll) {
          e.preventDefault();
          setState((s) => ({ ...s, ids: [...itemIds] }));
        }
        return;
      }
      // An arrow key hands control back to the keyboard cursor
      if (size > 0 && !e.metaKey && !e.ctrlKey && !e.altKey && ARROW_KEYS.includes(e.key)) {
        setState((s) => ({ ...s, ids: [], anchorId: null }));
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [stateRef]);

  return { ids, ordered, toggle, extendTo, replace, clear };
}
