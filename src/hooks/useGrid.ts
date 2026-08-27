import { useEffect, useRef, useState } from "react";
import { useApps } from "@/hooks/useApps";
import { arrayMove, useDragGrid } from "@/hooks/useDragGrid";
import { useFolders } from "@/hooks/useFolders";
import { useFolderCreation } from "@/hooks/useFolderCreation";
import { useConfig, useDndSettings } from "@/hooks/useConfig";
import { useGridData } from "@/hooks/useGridData";
import { useFolderOperations } from "@/hooks/useFolderOperations";
import {
  NO_RETAINED_FOLDER_APPS,
  resolveFolderApps,
  withRetainedFolderApps,
  type RetainedFolderApps,
} from "@/utils/folderUtils";
import {
  compactPages,
  flattenPages,
  moveWithinPages,
  pagesEqual,
  replacePageSpan,
  sizesOf,
  splitBySizes,
} from "@/utils/pageUtils";
import { useDragHandoff, type PagedFolderInsert } from "@/hooks/useDragHandoff";
import { useDockDrag } from "@/hooks/useDockDrag";
import type { DragMoveInfo, DragEndInfo, DropAnimationInfo } from "@/hooks/useDragGrid";
import type { DragEngine, DropAnimationTarget } from "@/lib/helper-dnd";
import type { FolderMetadata } from "@/types/app";

export type { GridItemUnion } from "@/hooks/useGridData";

/** Drag behavior shared between the main grid and the paged layout's
 *  page engines (dock handoff, folder creation, drop animation) */
export interface PageDragHandlers {
  onDragStart: () => void;
  /** Returns true while the Dock session owns the gesture, so page-level
   *  behavior (the flip dwell) can stand down with folder creation */
  onDragMove: (info: DragMoveInfo) => boolean;
  onDragEnd: (info: DragEndInfo, reorder: () => void, complete: () => void) => void;
  onDragCancel: () => void;
  getDropAnimationTarget: (info: DropAnimationInfo) => DropAnimationTarget | null | undefined;
}

export function useGrid() {
  const { apps, folders: physicalFolders, unreadableDirs } = useApps();
  const { orderConfig, saveOrder, layout } = useConfig();

  // Folders management — seeded from config by useGridData's init pass,
  // then local state is the single source of truth. (A derived fallback to
  // orderConfig here previously caused data loss: creating the first folder
  // of a session flipped the list to just that folder.)
  const { folders, setFolders, createNewFolder } = useFolders([]);

  // Get DnD settings for animation control
  const { overlapThreshold } = useDndSettings();

  // While a page engine owns the gesture (paged layout), dock pinning must
  // read the ghost from that engine, not from the hidden main grid's
  const activePageEngineRef = useRef<(() => DragEngine | null) | null>(null);
  const [setActivePageEngine] = useState(
    () =>
      (getEngine: (() => DragEngine | null) | null) => {
        activePageEngineRef.current = getEngine;
      }
  );

  // The main grid's drag hook owns the flat order (the item sequence);
  // page sizes partition it into the explicit pages the paged layout
  // shows (see pageUtils). Pages are derived from both every render, so
  // the two can never disagree.
  const [pageSizes, setPageSizes] = useState<number[]>([]);

  // Folder apps this launch's scan could not verify (a directory that
  // failed to read): kept out of the live folders, put back at save time
  const [retainedFolderApps, setRetainedFolderApps] =
    useState<RetainedFolderApps>(NO_RETAINED_FOLDER_APPS);

  // Drag behavior shared by the main grid and the paged layout's page
  // engines. Everything here is id-based and reads its collaborators
  // lazily, so it works regardless of which engine owns the gesture.
  const sharedDragHandlers: PageDragHandlers = {
    onDragStart() {
      // A silent teardown path (no end/cancel event) must not leave the
      // previous gesture's handoff state pinned to this item
      dockDrag.reset();
    },
    onDragMove(info: DragMoveInfo) {
      // Dock handoff first: once the pointer is in the Dock zone the
      // gesture goes native and folder-creation logic must stand down.
      // Standing down includes disarming it: a drop-target ring armed just
      // before entering the zone must not survive into a release here —
      // a stale match would create a folder on an aborted Dock drag.
      if (dockDrag.handleDragMove(info)) {
        handleFolderDragCancel();
        return true;
      }
      handleFolderDragMove(info);
      return false;
    },
    onDragEnd(info: DragEndInfo, reorder: () => void, complete: () => void) {
      dockDrag.reset();
      handleFolderDragEnd(info, reorder, complete);
    },
    onDragCancel() {
      dockDrag.reset();
      handleFolderDragCancel();
    },
    getDropAnimationTarget(info: DropAnimationInfo) {
      if (!info.overId || info.overlapRatio < overlapThreshold) {
        return undefined;
      }
      const activeType = gridData.getItemType(info.activeId);
      const overType = gridData.getItemType(info.overId);
      if (activeType === "app" && (overType === "app" || overType === "folder")) {
        return null;
      }
      return undefined;
    },
  };

  // Main drag grid hook (declared before sub-hooks that need it)
  const dragGrid = useDragGrid({
    initialOrder: null,
    ...sharedDragHandlers,
    onDragEnd(info: DragEndInfo, reorder: () => void, complete: () => void) {
      sharedDragHandlers.onDragEnd(
        info,
        () => {
          // A scroll-layout drop re-partitions in the same commit as the
          // hook's own order update, so no intermediate structure is ever
          // rendered or persisted: the moved item leaves its page and
          // joins its new neighbor's, every other page keeps its contents,
          // and sparse pages survive a detour through the scroll layout.
          // reorder() is the hook's only order-changing path here
          // (onDragExit/onDragOutside are not wired), so nothing else
          // needs to re-partition.
          if (dragGrid.order && info.fromIndex !== info.toIndex) {
            const newOrder = arrayMove(dragGrid.order, info.fromIndex, info.toIndex);
            const moved = moveWithinPages(pages, newOrder, info.activeId);
            setPageSizes(sizesOf(compactPages(moved)));
          }
          reorder();
        },
        complete
      );
    },
  });

  const pages = splitBySizes(dragGrid.order ?? [], pageSizes);

  /** Make a page structure current. Empty pages are retired unless kept:
   *  a live paged drag keeps the page it emptied in place until the
   *  gesture ends, so page indices don't shift under it. */
  function setPages(newPages: string[][], keepEmpty = false) {
    const next = keepEmpty ? newPages : compactPages(newPages);
    dragGrid.setOrder(flattenPages(next));
    setPageSizes(sizesOf(next));
  }

  /** Reorder within one page (a page engine's drop): rewrites that page's
   *  span of the flat order. Functional, so it composes with whatever
   *  else the same drop committed instead of overwriting it. */
  function reorderPage(pageIds: string[]) {
    dragGrid.setOrder((prev) => {
      if (!prev) return prev;
      const next = replacePageSpan(prev, pageIds);
      if (next === prev) {
        console.warn("useGrid: dropped a page reorder that no longer matches a page");
      }
      return next;
    });
  }

  /** Retire empty pages once a paged drag has ended. Functional on the
   *  sizes alone — the flat order is untouched, so a sequence change
   *  committed by the same drop can never be overwritten. */
  function retireEmptyPages() {
    setPageSizes((prev) => (prev.includes(0) ? prev.filter((size) => size > 0) : prev));
  }

  // Persist the arrangement whenever it changes after seeding (value-
  // compared, as pages are re-derived every render). An effect rather
  // than a save per mutation, so updates that compose within one tick
  // persist their combined result and never a stale snapshot.
  const lastSavedRef = useRef<{ pages: string[][]; folders: FolderMetadata[] } | null>(null);
  useEffect(() => {
    if (dragGrid.order === null) return; // nothing seeded yet
    const last = lastSavedRef.current;
    if (last === null) {
      // The seed commit is the baseline, not a change: reconciling against
      // discovery prunes whatever wasn't found, and a scan can come up
      // short (a directory that failed to read), so the result must not
      // reach the backend until the user actually changes something
      lastSavedRef.current = { pages, folders };
      return;
    }
    if (last.folders === folders && pagesEqual(last.pages, pages)) return;
    lastSavedRef.current = { pages, folders };
    saveOrder(pages, withRetainedFolderApps(folders, retainedFolderApps));
  }, [pages, folders, dragGrid.order, saveOrder, retainedFolderApps]);

  // Item building & order initialization
  const gridData = useGridData({
    apps,
    physicalFolders,
    unreadableDirs,
    folders,
    orderConfig,
    order: dragGrid.order,
    setPages,
    setFolders,
    setRetainedFolderApps,
    activeId: dragGrid.activeId,
  });

  // Launchpad-style drag-to-Dock pinning
  const dockDrag = useDockDrag({
    getEngine: () => activePageEngineRef.current?.() ?? dragGrid.getEngine(),
    isPinnable: (id) => gridData.getItemType(id) === "app",
  });

  // Folder CRUD & open/close state
  const folderOps = useFolderOperations({
    folders,
    setFolders,
    createNewFolder,
    appsMap: gridData.appsMap,
    physicalFolders,
    pages,
    setPages,
  });

  // Folder creation DnD detection
  const {
    dropTarget,
    handleDragMove: handleFolderDragMove,
    handleDragEnd: handleFolderDragEnd,
    handleDragCancel: handleFolderDragCancel,
  } = useFolderCreation({
    getItemType: gridData.getItemType,
    onCreateFolder: folderOps.handleCreateFolder,
    onAddToFolder: folderOps.handleAddToFolder,
  });

  // The open folder is fully derived: openFolderId + folders + appsMap are
  // the sources of truth, so icon loads, renames and content changes are
  // always live. When the folder is dissolved this becomes null in the
  // same commit and the modal unmounts.
  const openFolderMeta = folderOps.openFolderId
    ? folders.find((f) => f.id === folderOps.openFolderId)
    : undefined;
  const openFolder = openFolderMeta
    ? {
        id: openFolderMeta.id,
        name: openFolderMeta.name,
        apps: resolveFolderApps(openFolderMeta.appPaths, gridData.appsMap),
      }
    : null;

  // While the paged layout is active, PagedGrid registers how a folder
  // drag-out lands on the visible page (scroll layout: null, the default
  // placement on the last page applies)
  const pagedFolderInsertRef = useRef<PagedFolderInsert | null>(null);
  const [setPagedFolderInsert] = useState(
    () =>
      (insert: PagedFolderInsert | null) => {
        pagedFolderInsertRef.current = insert;
      }
  );

  // Coordinator for drag handoff out of the folder modal. The main grid
  // participates only in scroll layout; in paged layout the current page
  // registers instead (PagedGrid), so a drag-out always has exactly one
  // candidate target.
  const { coordinator } = useDragHandoff({
    openFolderId: folderOps.openFolderId,
    setOpenFolderId: folderOps.setOpenFolderId,
    folders,
    setFolders,
    pages,
    setPages,
    dragGrid,
    registerMainGrid: layout !== "paged",
    pagedFolderInsertRef,
  });

  return {
    // Data
    items: gridData.items,
    itemIds: gridData.itemIds,
    activeItem: gridData.activeItem,
    openFolder,
    newFolderId: folderOps.newFolderId,
    /** Page structure of the main grid (what the paged layout shows) */
    pages,

    // DnD
    containerRef: dragGrid.containerRef,
    isDragging: dragGrid.isDragging,
    activeId: dragGrid.activeId,
    cancelDrag: dragGrid.cancelDrag,
    dropTarget,

    // Coordinator for folder handoff
    coordinator,

    // Paged layout integration: page commits (a flip, a newly opened
    // page, the fit to the viewport), shared drag behavior, and the
    // bridges that route dock pinning and folder drag-out to pages
    handlePagesChange: setPages,
    reorderPage,
    retireEmptyPages,
    pageDragHandlers: sharedDragHandlers,
    setActivePageEngine,
    setPagedFolderInsert,

    // Folder handlers
    handleOpenFolder: folderOps.handleOpenFolder,
    handleCloseFolder: folderOps.handleCloseFolder,
    handleRenameFolder: folderOps.handleRenameFolder,
    handleFolderOrderChange: folderOps.handleFolderOrderChange,
    handleRemoveFromFolder: folderOps.handleRemoveFromFolder,
    handleUngroupFolder: folderOps.handleUngroupFolder,
    getOpenFolderSavedOrder: folderOps.getOpenFolderSavedOrder,

    // Multi-selection actions (see useSelection in the host)
    handleCreateFolderFrom: folderOps.handleCreateFolderFrom,
    handleMoveToFolder: folderOps.handleMoveToFolder,
  };
}
