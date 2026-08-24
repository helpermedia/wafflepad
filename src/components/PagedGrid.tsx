import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppItem } from "@/components/items/AppItem";
import { FolderItem, type GridFolder } from "@/components/items/FolderItem";
import { IconGrid } from "@/components/ui/IconGrid";
import { useDragGrid, type DragMoveInfo } from "@/hooks/useDragGrid";
import { useLatestRef } from "@/hooks/useLatestRef";
import { GRID_COLUMNS, GRID_GAP, TILE_HEIGHT, pageGridId } from "@/constants/grid";
import { cn } from "@/utils/cn";
import {
  appendToLastPage,
  insertIntoPage,
  normalizePages,
  pagesEqual,
  removeFromPages,
} from "@/utils/pageUtils";
import { watchPointerRelease } from "@/lib/helper-dnd";
import type { DragCoordinator, DragEngine, Point } from "@/lib/helper-dnd";
import type { GridItemUnion, PageDragHandlers } from "@/hooks/useGrid";
import type { PagedFolderInsert } from "@/hooks/useDragHandoff";
import type { DropAction } from "@/hooks/useFolderCreation";

/** An in-progress drag inside one of the pages, for host-level guards
 *  and for routing dock pinning to the engine that owns the gesture */
export interface PagedDragHandle {
  pageIndex: number;
  cancel: () => void;
  getEngine: () => DragEngine | null;
}

/** How a page exposes its engine to the flip machinery */
interface PageRegistration {
  getEngine: () => DragEngine | null;
  getContainer: () => HTMLElement | null;
}

/** Zone along the viewport's left/right edge that arms a page flip */
const FLIP_EDGE_SIZE = 40;

/** How long the pointer must dwell in the edge zone before flipping —
 *  deliberately longer than the Dock's 150ms: a flip relocates the item
 *  across pages, and grazing the edge mid-reorder must not trigger it */
const FLIP_DWELL_MS = 400;

/** Duration of the page slide when a drag flips pages */
const FLIP_ANIMATION_MS = 300;

/** Duration of a page turn (wheel, dots, keyboard): the same slide as
 *  the drag flip, given a little more time */
const TURN_ANIMATION_MS = 500;

/** Gap between wheel events that separates two gestures: a scroll wheel's
 *  notches arrive slower than this, a trackpad's stream and its momentum
 *  tail faster */
const WHEEL_GAP_MS = 80;

/** Slide the viewport with per-frame instant scrolls: a native smooth
 *  scroll has no completion signal (the flip's target engine must cache
 *  item rects only after the viewport settles) and is interrupted by
 *  further wheel input (a wheel page turn must survive its gesture's
 *  momentum tail, yielding only to the next turn via isCancelled) */
function animateViewportTo(
  el: HTMLElement,
  targetLeft: number,
  durationMs: number,
  isCancelled?: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    const startLeft = el.scrollLeft;
    const delta = targetLeft - startLeft;
    const start = performance.now();
    function frame(now: number) {
      if (isCancelled?.()) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      el.scrollTo({ left: startLeft + delta * eased, behavior: "instant" });
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

/** One wheel gesture's running state (see readWheelTurn) */
interface WheelState {
  /** The axis the gesture opened on — it keeps it, so a diagonal stroke
   *  can't flicker between axes and read as reversals */
  axis: "x" | "y";
  lastTime: number;
  lastDelta: number;
  /** Largest magnitude of the gesture so far */
  peak: number;
  /** Smallest magnitude since the gesture began to decay */
  trough: number;
  /** The gesture has fallen clearly below its peak (momentum) */
  decayed: boolean;
  /** Page the running slide is heading to, until it lands */
  target: number | null;
  /** Bumped by every slide and cancel: a slide stops once it no longer
   *  holds the current id */
  slideId: number;
}

/**
 * Interpret one wheel event against the gesture state: the direction of
 * the page turn this event starts, or 0. A gesture turns one page the
 * moment it starts (a swipe must not wait for its momentum to die down);
 * gestures are told apart without phase information — a gap between
 * events (a wheel's notches), a change of direction, or a sharp rise in
 * delta once the stream has begun to decay (a second swipe during the
 * first one's momentum tail).
 */
function readWheelTurn(
  wheel: WheelState,
  e: { deltaX: number; deltaY: number; timeStamp: number }
): -1 | 0 | 1 {
  const fresh = e.timeStamp - wheel.lastTime > WHEEL_GAP_MS;
  if (fresh) {
    const ax = Math.abs(e.deltaX);
    const ay = Math.abs(e.deltaY);
    // Latch the axis only on a clear, dominant opening: noise or a
    // diagonal first event must not pick the axis (and with it the
    // direction) for the whole gesture. Deferring leaves lastTime
    // untouched, so the next event may still open the gesture.
    if (Math.max(ax, ay) < 3 || Math.max(ax, ay) < Math.min(ax, ay) * 1.5) return 0;
    wheel.axis = ax > ay ? "x" : "y";
  }
  const delta = wheel.axis === "x" ? e.deltaX : e.deltaY;
  const magnitude = Math.abs(delta);
  if (magnitude < 2) return 0;

  let starts = false;
  if (fresh || Math.sign(delta) !== Math.sign(wheel.lastDelta)) {
    starts = true;
  } else if (wheel.decayed && magnitude > wheel.trough * 2 + 2) {
    // Tested before the peak update: a second swipe ramping through the
    // first one's tail must turn at its onset, not at its peak
    starts = true;
  } else if (magnitude > wheel.peak) {
    wheel.peak = magnitude;
  } else if (!wheel.decayed) {
    if (magnitude < wheel.peak * 0.5) {
      wheel.decayed = true;
      wheel.trough = magnitude;
    }
  } else if (magnitude < wheel.trough) {
    wheel.trough = magnitude;
  }
  if (starts) {
    wheel.peak = magnitude;
    wheel.trough = magnitude;
    wheel.decayed = false;
  }
  wheel.lastTime = e.timeStamp;
  wheel.lastDelta = delta;
  return starts ? (delta > 0 ? 1 : -1) : 0;
}

/** Ease the viewport to a page; a slide already running yields to it.
 *  onHiddenLand reports a slide that finished against a 0-width (hidden)
 *  viewport and so could not move it — the un-hide restore aims there. */
function slideViewportToPage(
  el: HTMLElement,
  wheel: WheelState,
  target: number,
  onHiddenLand: (target: number) => void
): void {
  wheel.target = target;
  const id = ++wheel.slideId;
  void animateViewportTo(el, target * el.clientWidth, TURN_ANIMATION_MS, () => wheel.slideId !== id).then(() => {
    if (wheel.slideId !== id) return;
    wheel.target = null;
    if (el.clientWidth === 0) onHiddenLand(target);
  });
}

/** Abandon the gesture and any slide in flight */
function cancelWheelGesture(wheel: WheelState): void {
  wheel.lastTime = 0;
  wheel.target = null;
  wheel.slideId += 1;
}

interface PagedGridProps {
  items: GridItemUnion[];
  selectedId: string | null;
  launchingPath: string | null;
  /** Kept mounted while true (search open, folder open) so the page
   *  position survives; display:none resets scrollLeft without an event */
  hidden: boolean;
  onLaunch: (path: string) => void;
  onCloseApp: () => void;
  onOpenFolder: (folder: GridFolder) => void;
  onUngroupFolder: (folder: GridFolder) => void;
  /** Inline folder rename: host-owned state and its transitions */
  renamingFolderId: string | null;
  onRenameStart: (folder: GridFolder) => void;
  onRenameEnd: (folder: GridFolder, newName: string | null) => void;
  /** Committed page structure (ids); items resolve the tiles */
  pages: string[][];
  /** Commit a new page structure. keepEmpty leaves empty pages in place
   *  (a live drag keeps the page it emptied, see endDrag) instead of
   *  retiring them */
  onPagesChange: (pages: string[][], keepEmpty?: boolean) => void;
  /** A page's drop reordered it: its new sequence, replacing that page's
   *  span of the flat order */
  onPageReorder: (pageIds: string[]) => void;
  /** A page drag ended: retire the pages it emptied (see endDrag) */
  onRetireEmptyPages: () => void;
  /** Reports the active page drag, null when none (Escape and guards) */
  onDragStateChange: (drag: PagedDragHandle | null) => void;
  /** Dock handoff, folder creation and drop animation (from useGrid) */
  dragHandlers: PageDragHandlers;
  /** Folder-creation ring target (shared with the main grid's logic) */
  dropTarget: { id: string; action: DropAction } | null;
  /** Handoff coordinator: the current page registers as the folder
   *  drag-out target while the paged layout is visible */
  coordinator: DragCoordinator;
  /** Registers how a folder drag-out lands in the visible page's window;
   *  called with null on unmount */
  registerFolderInsert: (insert: PagedFolderInsert | null) => void;
}

interface PageProps {
  pageItems: GridItemUnion[];
  pageIndex: number;
  /** The page at the current scroll position — it alone registers with
   *  the handoff coordinator, so a folder drag-out targets it */
  isCurrent: boolean;
  selectedId: string | null;
  launchingPath: string | null;
  onLaunch: (path: string) => void;
  onCloseApp: () => void;
  onOpenFolder: (folder: GridFolder) => void;
  onUngroupFolder: (folder: GridFolder) => void;
  renamingFolderId: string | null;
  onRenameStart: (folder: GridFolder) => void;
  onRenameEnd: (folder: GridFolder, newName: string | null) => void;
  onOrderChange: (pageIds: string[]) => void;
  onDragStateChange: (pageIndex: number, drag: PagedDragHandle | null) => void;
  onDragMove: (pageIndex: number, info: DragMoveInfo, dockOwned: boolean) => void;
  registerPage: (pageIndex: number, registration: PageRegistration) => void;
  unregisterPage: (pageIndex: number) => void;
  /** Item mid-flip into this render: its tile hides before its engine
   *  adopts the drag, or ghost and tile would both show during the slide */
  pendingDragId: string | null;
  dragHandlers: PageDragHandlers;
  dropTarget: { id: string; action: DropAction } | null;
  coordinator: DragCoordinator;
}

/**
 * One page with its own drag engine, so slot detection sees single-page
 * geometry. Reorders splice back into the master order via onOrderChange.
 * Renders from the hook's order (the drag commit path) while item data
 * resolves fresh from props, keeping icon loads live. External slice
 * changes (cross-page moves, overflow cascading between pages) are
 * synced into the hook whenever the id set differs; same-set sequence
 * changes stay owned by the hook, whose order runs ahead of the parent
 * during a local drop commit.
 */
function Page({
  pageItems,
  pageIndex,
  isCurrent,
  selectedId,
  launchingPath,
  onLaunch,
  onCloseApp,
  onOpenFolder,
  onUngroupFolder,
  renamingFolderId,
  onRenameStart,
  onRenameEnd,
  onOrderChange,
  onDragStateChange,
  onDragMove,
  registerPage,
  unregisterPage,
  pendingDragId,
  dragHandlers,
  dropTarget,
  coordinator,
}: PageProps) {
  const { containerRef, order, setOrder, activeId, cancelDrag, getEngine } = useDragGrid({
    initialOrder: pageItems.map((item) => item.data.id),
    // No-op today (AutoScroller only attaches to vertical-overflow hosts,
    // which pages don't have) — pinned off so a future AutoScroller change
    // can't start moving the paged viewport under a live drag
    engineOptions: { autoScroll: false },
    onOrderChange,
    onDragStart: () => {
      dragHandlers.onDragStart();
      onDragStateChange(pageIndex, { pageIndex, cancel: cancelDrag, getEngine });
    },
    onDragMove: (info) => {
      // Shared behavior first — Dock handoff outranks the flip dwell,
      // exactly as it outranks folder creation
      const dockOwned = dragHandlers.onDragMove(info);
      onDragMove(pageIndex, info, dockOwned);
    },
    onDragEnd: (info, reorder, complete) => {
      dragHandlers.onDragEnd(info, reorder, () => {
        complete();
        onDragStateChange(pageIndex, null);
      });
    },
    onDragCancel: () => {
      dragHandlers.onDragCancel();
      onDragStateChange(pageIndex, null);
    },
    getDropAnimationTarget: dragHandlers.getDropAnimationTarget,
  });

  // Sync external slice changes into the hook: setState during render
  // (React retries synchronously before commit, per house convention)
  const sliceIds = pageItems.map((item) => item.data.id);
  const currentOrder = order ?? [];
  const orderIdSet = new Set(currentOrder);
  const sameIdSet =
    currentOrder.length === sliceIds.length && sliceIds.every((id) => orderIdSet.has(id));
  if (!sameIdSet) {
    setOrder(sliceIds);
  }

  // Expose the engine to the flip machinery. The mount-time registration
  // object is enough: its getters close over stable refs.
  const registrationRef = useLatestRef<PageRegistration>({
    getEngine,
    getContainer: () => containerRef.current,
  });
  useEffect(() => {
    registerPage(pageIndex, registrationRef.current);
    return () => unregisterPage(pageIndex);
  }, [registerPage, unregisterPage, pageIndex, registrationRef]);

  // Only the current page joins the handoff coordinator, so a folder
  // drag-out has exactly one candidate target: this page. Its engine
  // exists before this runs (useDragGrid's effect is registered first).
  useEffect(() => {
    if (!isCurrent) return;
    const engine = registrationRef.current.getEngine();
    const container = registrationRef.current.getContainer();
    if (!engine || !container) {
      console.warn("PagedGrid: current page engine not ready, folder drag-out disabled");
      return;
    }
    const id = pageGridId(pageIndex);
    coordinator.register({ id, engine, container });
    return () => coordinator.unregister(id);
  }, [isCurrent, coordinator, pageIndex, registrationRef]);

  // Engine teardown paths (unmount mid-drag, destroy during the drop
  // animation) emit no events — release the host's drag handle on the way
  // out so guards can't wedge on a drag that no longer exists. The owner
  // check upstream makes this a no-op for pages that aren't dragging.
  const releaseRef = useLatestRef(() => onDragStateChange(pageIndex, null));
  useEffect(() => {
    // Mount-time capture (lint-preferred): the closure only touches stable
    // values (pageIndex never changes; the handler chain ends in stable
    // setters and refs), so latest-vs-mount is equivalent here
    const release = releaseRef.current;
    return () => release();
  }, [releaseRef]);

  const itemsById = new Map(pageItems.map((item) => [item.data.id, item]));
  const ordered = (order ?? []).flatMap((id) => itemsById.get(id) ?? []);

  return (
    <IconGrid ref={containerRef} className="max-w-7xl mx-auto">
      {ordered.map((item) => {
        const dropAction = dropTarget?.id === item.data.id ? dropTarget.action : undefined;
        return item.type === "app" ? (
          <AppItem
            key={item.data.id}
            item={item.data}
            isDragActive={activeId !== null}
            isDragging={activeId === item.data.id || pendingDragId === item.data.id}
            dropAction={dropAction}
            isSelected={selectedId === item.data.id}
            onLaunch={onLaunch}
            onCloseApp={onCloseApp}
            isLaunching={launchingPath === item.data.path}
          />
        ) : (
          <FolderItem
            key={item.data.id}
            item={item.data}
            isDragActive={activeId !== null}
            isDragging={activeId === item.data.id || pendingDragId === item.data.id}
            dropAction={dropAction}
            isSelected={selectedId === item.data.id}
            onOpen={onOpenFolder}
            onUngroup={onUngroupFolder}
            isRenaming={renamingFolderId === item.data.id}
            onRenameStart={onRenameStart}
            onRenameEnd={onRenameEnd}
          />
        );
      })}
    </IconGrid>
  );
}

/**
 * Launchpad-style paged layout: full-width pages slid horizontally by
 * wheel gestures on either axis, the dots and drag flips (never natively
 * scrolled), each holding the items arranged on it (packed from the first slot,
 * possibly sparse) up to as many whole rows as the viewport fits —
 * overflow cascades onto the next page. Each page runs its own drag
 * engine with the main grid's shared behavior (reorder, folder creation,
 * Dock pinning); dwelling at a viewport edge mid-drag flips to the
 * adjacent page — or opens a new one past the last — and hands the
 * gesture off to its engine, and folder drag-outs adopt onto the current
 * page via the coordinator.
 */
export function PagedGrid({
  items,
  selectedId,
  launchingPath,
  hidden,
  onLaunch,
  onCloseApp,
  onOpenFolder,
  onUngroupFolder,
  renamingFolderId,
  onRenameStart,
  onRenameEnd,
  pages: committedPages,
  onPagesChange,
  onPageReorder,
  onRetireEmptyPages,
  onDragStateChange,
  dragHandlers,
  dropTarget,
  coordinator,
  registerFolderInsert,
}: PagedGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(0);
  const [page, setPage] = useState(0);
  const [isPageDragging, setIsPageDragging] = useState(false);
  const [pendingDragId, setPendingDragId] = useState<string | null>(null);

  // Pages register their engines here for the flip handoff
  const [pagesMap] = useState(() => new Map<number, PageRegistration>());
  const [pageRegistry] = useState(() => ({
    register: (index: number, registration: PageRegistration) => {
      pagesMap.set(index, registration);
    },
    unregister: (index: number) => {
      pagesMap.delete(index);
    },
  }));

  // Which page owns the live drag: N pages report into one handle slot,
  // so a late clear (unmount, teardown) from a non-owner must not wipe
  // another page's active drag
  const dragOwnerRef = useRef<number | null>(null);

  // Edge-dwell flip state. While a flip is in flight, handle clears from
  // the source page's cancel are suppressed — the drag continues on the
  // target, and dropping the handle would open a frames-wide window where
  // Escape falls through to close-the-launcher.
  const flipRef = useRef<{
    inProgress: boolean;
    armedDirection: -1 | 0 | 1;
    timer: number | null;
  }>({ inProgress: false, armedDirection: 0, timer: null });
  const lastPointerRef = useRef<Point>({ x: 0, y: 0 });

  function clearFlipDwell() {
    const flip = flipRef.current;
    if (flip.timer !== null) {
      clearTimeout(flip.timer);
      flip.timer = null;
    }
    flip.armedDirection = 0;
  }

  useEffect(() => {
    const flip = flipRef.current;
    return () => {
      if (flip.timer !== null) clearTimeout(flip.timer);
    };
  }, []);

  // The window is fullscreen and never resizes, but the grid can mount
  // hidden (0 height) — measure whenever it becomes visible. The rect is
  // cached for the per-move edge checks: measuring there would force a
  // style recalc after every ghost/shift transform write.
  const viewportRectRef = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (hidden || !el || el.clientHeight === 0) return;
    viewportRectRef.current = el.getBoundingClientRect();
    setRows(Math.max(1, Math.floor((el.clientHeight + GRID_GAP) / (TILE_HEIGHT + GRID_GAP))));
  }, [hidden]);

  // display:none (search, folder modal) drops scrollLeft to 0 without a
  // scroll event; restore the active page synchronously on un-hide.
  // Layout effect, no rAF: a folder drag-out adopts onto the current page
  // right after the un-hiding commit, and the target engine must cache
  // item rects with the viewport already restored — an async restore can
  // lose the race when the scheduler yields under continuous pointer input.
  const wasHiddenRef = useRef(hidden);
  useLayoutEffect(() => {
    if (wasHiddenRef.current && !hidden) {
      const el = viewportRef.current;
      // Instant: the page was already there before the hide — or a slide
      // was still heading to it when the hide interrupted
      const target = wheelRef.current.target ?? page;
      el?.scrollTo({ left: target * el.clientWidth, behavior: "instant" });
    }
    wasHiddenRef.current = hidden;
  }, [hidden, page]);

  const perPage = rows * GRID_COLUMNS;
  // Display structure: the committed pages fitted to the viewport's
  // capacity (overflow cascades forward). Empty pages are shown as they
  // come — the committed state holds one only while a page drag is live
  // (the page a flip emptied keeps its slot until the gesture ends, so
  // page indices don't shift under the drag); endDrag retires them.
  const pages = perPage > 0 ? normalizePages(committedPages, perPage, true) : [];
  const itemsById = new Map(items.map((item) => [item.data.id, item]));
  const pageItemLists = pages.map((ids) => ids.flatMap((id) => itemsById.get(id) ?? []));

  // Persist the fitted structure when it differs from the committed one
  // outside a drag — a display change shrank the capacity, a scroll-
  // layout session grew the last page, or a session ended mid-drag with
  // an empty page — so stored and shown pages agree
  const onPagesChangeRef = useLatestRef(onPagesChange);
  useEffect(() => {
    if (isPageDragging || perPage === 0) return;
    const fitted = normalizePages(committedPages, perPage, false);
    if (!pagesEqual(fitted, committedPages)) onPagesChangeRef.current(fitted);
  }, [committedPages, perPage, isPageDragging, onPagesChangeRef]);

  // endDrag runs from engine callbacks and from performFlip's async tail,
  // whose closures predate the flip's own commit — it reads the latest
  // render instead
  const latestRef = useLatestRef({ pages, page, onRetireEmptyPages });

  // After endDrag retired pages before the current one, the content under
  // the viewport shifted left by that many pages: re-aim it before paint
  const pendingPageRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const target = pendingPageRef.current;
    if (target === null) return;
    pendingPageRef.current = null;
    const el = viewportRef.current;
    el?.scrollTo({ left: target * el.clientWidth, behavior: "instant" });
  });

  // A folder drag-out lands at the visible page's last slot: everything
  // before it stays put; on a full page the previous last item cascades
  // onward — the calm-entry counterpart of the flip's near-edge insertion
  const folderInsertRef = useLatestRef<PagedFolderInsert>((pagesWithoutItem, itemId) => {
    if (perPage === 0) return appendToLastPage(pagesWithoutItem, [itemId]);
    const fitted = normalizePages(pagesWithoutItem, perPage, false);
    const visible = Math.min(page, Math.max(0, fitted.length - 1));
    const slot = Math.min(fitted[visible]?.length ?? 0, perPage - 1);
    return normalizePages(insertIntoPage(fitted, visible, slot, itemId), perPage, false);
  });
  useEffect(() => {
    registerFolderInsert((pagesWithoutItem, itemId) =>
      folderInsertRef.current(pagesWithoutItem, itemId)
    );
    return () => registerFolderInsert(null);
  }, [registerFolderInsert, folderInsertRef]);

  /** The gesture is over (drop, cancel or teardown): release the handle
   *  and retire the pages it emptied. Retiring a page before the current
   *  one shifts the content under the viewport, so the current index
   *  moves with it and the scroll is re-aimed before paint. */
  function endDrag() {
    const { pages, page, onRetireEmptyPages } = latestRef.current;
    dragOwnerRef.current = null;
    clearFlipDwell();
    setIsPageDragging(false);
    onDragStateChange(null);
    if (!pages.some((p) => p.length === 0)) return;
    const emptyBefore = pages.slice(0, page).filter((p) => p.length === 0).length;
    onRetireEmptyPages();
    if (emptyBefore > 0) {
      pendingPageRef.current = page - emptyBefore;
      setPage(page - emptyBefore);
    }
  }

  function handleDragStateChange(pageIndex: number, drag: PagedDragHandle | null) {
    if (drag === null && (flipRef.current.inProgress || dragOwnerRef.current !== pageIndex)) {
      return;
    }
    if (drag === null) {
      endDrag();
      return;
    }
    cancelWheel(); // nothing may move the viewport under a drag
    dragOwnerRef.current = pageIndex;
    setIsPageDragging(true);
    onDragStateChange(drag);
  }

  /** Arm, re-aim or clear the edge dwell for the current drag position */
  function handlePageDragMove(pageIndex: number, info: DragMoveInfo, dockOwned: boolean) {
    lastPointerRef.current = info.pointer;
    const rect = viewportRectRef.current;
    const flip = flipRef.current;
    if (!rect || flip.inProgress) return;

    // A left/right Dock's zone can overlap the flip zones: once the Dock
    // owns the gesture, a flip firing mid-handoff would adopt the hidden
    // ghost into an invisible drag beside the live native session
    if (dockOwned) {
      clearFlipDwell();
      return;
    }

    const direction: -1 | 0 | 1 =
      info.pointer.x < rect.left + FLIP_EDGE_SIZE
        ? -1
        : info.pointer.x > rect.right - FLIP_EDGE_SIZE
          ? 1
          : 0;
    const targetPage = pageIndex + direction;
    // Past the last page a new page opens for the item (Launchpad) —
    // unless the item is alone on its page, which would only relocate
    // that page
    const opensPage =
      direction === 1 && targetPage === pages.length && (pages[pageIndex]?.length ?? 0) > 1;

    if (direction === 0 || targetPage < 0 || (targetPage >= pages.length && !opensPage)) {
      clearFlipDwell();
      return;
    }
    if (flip.armedDirection === direction) return; // dwell already running

    clearFlipDwell();
    flip.armedDirection = direction;
    flip.timer = window.setTimeout(() => {
      flip.timer = null;
      flip.armedDirection = 0;
      void performFlip(pageIndex, targetPage, info.activeId);
    }, FLIP_DWELL_MS);
  }

  /**
   * Keep the detached ghost under the pointer while the flip animates:
   * no engine is tracking moves in that window. Replicates GhostElement's
   * positioning scheme (fixed at 0,0 plus translate3d; scale matches its
   * DEFAULTS) — the target engine recalibrates from the ghost's rendered
   * rect on adoption, so any sub-pixel drift self-corrects.
   */
  function followGhost(ghost: HTMLElement): () => void {
    const rect = ghost.getBoundingClientRect();
    const start = lastPointerRef.current;
    const offsetX = rect.left - start.x;
    const offsetY = rect.top - start.y;
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      ghost.style.transform = `translate3d(${e.clientX + offsetX}px, ${e.clientY + offsetY}px, 0) scale(1.02)`;
    };
    document.addEventListener("pointermove", onMove, { capture: true });
    return () => document.removeEventListener("pointermove", onMove, true);
  }

  /**
   * Hand the live drag from one page's engine to the adjacent page's:
   * the same dance as DragCoordinator.handoff, plus the order move and
   * the viewport flip. Runs outside the coordinator deliberately — its
   * single onHandoff slot belongs to the folder flow.
   */
  async function performFlip(fromPage: number, toPage: number, itemId: string) {
    const fromEngine = pagesMap.get(fromPage)?.getEngine();
    const viewport = viewportRef.current;
    if (!fromEngine || !viewport) return;

    // The dwell can fire after the pointer released (a still pointer and a
    // released one both stop producing moves); adopting a ghost that is
    // already settling would corrupt the drop
    if (!fromEngine.isActivelyDragging()) return;

    const flip = flipRef.current;
    flip.inProgress = true;
    // The source tracker's listeners die at cancelForHandoff and the
    // target's only attach in startDragAt — a release inside the awaited
    // frames below would otherwise go unobserved and the adopted drag
    // could never end (frozen ghost, wedged guards)
    const releaseWatch = watchPointerRelease();
    try {
      // Ownership of the ghost transfers before the source cancels, so
      // nothing visual is destroyed. cancelForHandoff (not cancel) emits
      // onDragCancel, resetting the source page's React drag state; the
      // host handle survives because clears are suppressed mid-flip.
      const ghost = fromEngine.detachGhost();
      if (!ghost) {
        // Defensive (a live drag implies a ghost): kill the gesture before
        // dropping the guards, never the other way around
        fromEngine.cancelForHandoff();
        endDrag();
        return;
      }
      fromEngine.cancelForHandoff();

      // Move the item into the target page's near-edge slot (forward: the
      // first, backward: the last), opening the page when it lies past the
      // end. The target's overflow cascades forward; the page the item
      // left keeps its slot, even empty, until the gesture ends (endDrag).
      // The item's slot lands where the ghost already hovers. (Original
      // Launchpad left a hole on the source page instead; pages here pack.)
      const without = removeFromPages(pages, itemId);
      const slot =
        toPage > fromPage ? 0 : Math.min(without[toPage]?.length ?? 0, perPage - 1);
      const moved = normalizePages(insertIntoPage(without, toPage, slot, itemId), perPage, true);
      // Hidden from first paint on the target page (its engine only takes
      // over at adoption): committed in the same batch as the page move
      setPendingDragId(itemId);
      onPagesChange(moved, true);

      // Slide to the target page like a normal page change. The first
      // animation frame runs after React commits the new slices, and the
      // target engine caches item rects only after the viewport settles.
      const stopFollowing = followGhost(ghost);
      try {
        await animateViewportTo(viewport, toPage * viewport.clientWidth, FLIP_ANIMATION_MS);
      } finally {
        stopFollowing();
      }

      // Resolved only now: a page this flip opened mounts and registers
      // during the slide
      const target = pagesMap.get(toPage);
      const element = target
        ?.getContainer()
        ?.querySelector<HTMLElement>(`[data-draggable][data-id="${CSS.escape(itemId)}"]`);
      const toEngine = target?.getEngine();
      if (releaseWatch.wasReleased() || !element || !toEngine) {
        // Released mid-flip: the order move stands (the user did drag the
        // item to this page), but there is no live gesture left to adopt
        ghost.remove();
        endDrag();
        return;
      }

      // Adopt: emits onDragStart, so the target page takes over the handle
      toEngine.startDragAt(element, lastPointerRef.current, ghost);
    } finally {
      // The target's activeId hides the tile from here (same commit), so
      // clearing the pending id never flashes it visible
      setPendingDragId(null);
      releaseWatch.dispose();
      flip.inProgress = false;
    }
  }

  function goToPage(index: number) {
    if (isPageDragging) return;
    const el = viewportRef.current;
    if (el) slideToPage(el, index);
  }

  // Wheel input on either axis turns pages, eased by the same slide the
  // drag flip uses; the viewport never scrolls natively, so a gesture's
  // remaining events can't interrupt the slide the way they would a
  // native smooth scroll. Turns chain, each from the page the running
  // slide is heading to. The gesture reading itself lives in
  // readWheelTurn.
  const wheelRef = useRef<WheelState>({
    axis: "y",
    lastTime: 0,
    lastDelta: 0,
    peak: 0,
    trough: 0,
    decayed: false,
    target: null,
    slideId: 0,
  });
  useEffect(() => {
    const wheel = wheelRef.current;
    // Unmount only needs to stop a slide in flight (its frames would keep
    // scrolling a dead node)
    return () => {
      wheel.slideId += 1;
    };
  }, []);

  function cancelWheel() {
    cancelWheelGesture(wheelRef.current);
  }

  function slideToPage(el: HTMLElement, target: number) {
    slideViewportToPage(el, wheelRef.current, target, setPage);
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (isPageDragging) return;
    const el = viewportRef.current;
    if (!el) return;
    const wheel = wheelRef.current;
    const direction = readWheelTurn(wheel, e);
    if (direction === 0) return;
    const from = wheel.target ?? page;
    const target = Math.min(Math.max(from + direction, 0), pages.length - 1);
    if (target !== from) slideToPage(el, target);
  }

  // Keyboard selection: the nav walks the flat order, so a step can cross
  // onto another page — slide there. (scrollIntoView must not touch this
  // container, see data-paged-viewport: its minimal scroll would drag the
  // viewport off page boundaries.)
  const showSelectionRef = useLatestRef((selected: string) => {
    const el = viewportRef.current;
    if (!el || el.clientWidth === 0) return;
    const index = pages.findIndex((ids) => ids.includes(selected));
    const shown = wheelRef.current.target ?? Math.round(el.scrollLeft / el.clientWidth);
    if (index !== -1 && index !== shown) slideToPage(el, index);
  });
  useEffect(() => {
    if (selectedId !== null) showSelectionRef.current(selectedId);
  }, [selectedId, showSelectionRef]);

  return (
    <div className={cn("flex-1 min-h-0 flex flex-col", hidden && "hidden")}>
      <div
        ref={viewportRef}
        data-paged-viewport=""
        onWheel={handleWheel}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Hidden layouts fire spurious scrolls with a 0 width
          if (el.clientWidth === 0) return;
          setPage(Math.round(el.scrollLeft / el.clientWidth));
        }}
        // Never natively scrollable: every page move is a programmatic
        // eased slide (wheel gestures, the dots, drag flips), so no user
        // scroll can shift the cached item rects of a drag's start frame,
        // and no scroll snapping exists to re-snap a slide's frames into
        // a jump
        className="flex-1 min-h-0 flex overflow-hidden"
      >
        {pageItemLists.map((pageItems, index) => (
          <div key={index} className="w-full shrink-0">
            <Page
              pageItems={pageItems}
              pageIndex={index}
              // Clamped: after shrinking while hidden, `page` can exceed
              // the page count and no page would register for drag-out
              isCurrent={index === Math.min(page, pages.length - 1)}
              selectedId={selectedId}
              launchingPath={launchingPath}
              onLaunch={onLaunch}
              onCloseApp={onCloseApp}
              onOpenFolder={onOpenFolder}
              onUngroupFolder={onUngroupFolder}
              renamingFolderId={renamingFolderId}
              onRenameStart={onRenameStart}
              onRenameEnd={onRenameEnd}
              onOrderChange={onPageReorder}
              onDragStateChange={handleDragStateChange}
              onDragMove={handlePageDragMove}
              registerPage={pageRegistry.register}
              unregisterPage={pageRegistry.unregister}
              pendingDragId={pendingDragId}
              dragHandlers={dragHandlers}
              dropTarget={dropTarget}
              coordinator={coordinator}
            />
          </div>
        ))}
      </div>
      {/* Always mounted so the viewport height (and row fit) is stable */}
      <div data-keep-open className="flex h-8 items-center justify-center gap-2.5">
        {pages.length > 1 &&
          pages.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={`Page ${index + 1}`}
              onClick={() => goToPage(index)}
              className={cn(
                "w-2 h-2 rounded-full transition-colors",
                index === page ? "bg-white/70" : "bg-white/25 hover:bg-white/40"
              )}
            />
          ))}
      </div>
    </div>
  );
}
