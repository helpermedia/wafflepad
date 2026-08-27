import type { AppInfo, FolderInfo, FolderMetadata, OrderConfig } from "@/types/app";
import { buildAppsMap } from "@/utils/appUtils";
import {
  isFolderId,
  resolveFolderApps,
  resolveOrderToAppItems,
  convertPhysicalFolders,
  buildInitialPages,
  healFolders,
  type RetainedFolderApps,
} from "@/utils/folderUtils";
import type { GridItem } from "@/components/items/AppItem";
import type { GridFolder } from "@/components/items/FolderItem";

export type GridItemUnion =
  | { type: "app"; data: GridItem }
  | { type: "folder"; data: GridFolder };

interface UseGridDataOptions {
  apps: AppInfo[];
  physicalFolders: FolderInfo[];
  /** Directories this launch's scan could not read (see healFolders) */
  unreadableDirs: string[];
  folders: FolderMetadata[];
  orderConfig: OrderConfig | null;
  order: string[] | null;
  /** Seeds the page structure (and with it the flat order) once */
  setPages: (pages: string[][]) => void;
  setFolders: (folders: FolderMetadata[]) => void;
  /** Receives what the seed's healing left unverified, for the save */
  setRetainedFolderApps: (retained: RetainedFolderApps) => void;
  activeId: string | null;
}

export function useGridData({
  apps,
  physicalFolders,
  unreadableDirs,
  folders,
  orderConfig,
  order,
  setPages,
  setFolders,
  setRetainedFolderApps,
  activeId,
}: UseGridDataOptions) {
  // Create apps map for resolving folder apps
  // Include both top-level apps AND apps from physical folders (for initial conversion)
  const appsMap = buildAppsMap([
    ...apps,
    ...physicalFolders.flatMap((folder) => folder.apps),
  ]);

  // Get item type for folder creation hook
  function getItemType(id: string): "app" | "folder" | null {
    if (appsMap.has(id)) return "app";
    if (isFolderId(id)) return "folder";
    return null;
  }

  // Build items array from order
  function buildItems(currentOrder: string[] | null): GridItemUnion[] {
    if (!currentOrder) return [];
    const foldersMap = new Map(folders.map((f) => [f.id, f]));
    const resolvedApps = new Map(
      resolveOrderToAppItems(currentOrder, appsMap).map((item) => [item.id, item])
    );

    return currentOrder
      .map((id): GridItemUnion | null => {
        const appItem = resolvedApps.get(id);
        if (appItem) return { type: "app", data: appItem };

        if (isFolderId(id)) {
          const folder = foldersMap.get(id);
          if (folder) {
            return {
              type: "folder",
              data: { id, name: folder.name, apps: resolveFolderApps(folder.appPaths, appsMap) },
            };
          }
        }

        return null;
      })
      .filter((item): item is GridItemUnion => item !== null);
  }

  // Initialize order once apps/folders load
  if (order === null && (apps.length > 0 || physicalFolders.length > 0)) {
    // A saved arrangement brings its own folders, even none: only a first
    // launch (no arrangement at all) seeds folders from the physical ones,
    // or a user who ungrouped their last folder would get it back on the
    // next launch. Then heal them: drop uninstalled apps and folders left
    // empty, keeping aside what a directory that failed to read leaves
    // unverified, so the save can put it back.
    const { folders: effectiveFolders, retained } = healFolders(
      orderConfig ? orderConfig.folders : convertPhysicalFolders(physicalFolders),
      new Set(appsMap.keys()),
      unreadableDirs
    );
    if (retained.byFolder.size > 0 || retained.wholeFolders.length > 0) {
      setRetainedFolderApps(retained);
    }

    // Seed local folder state — from here on it is the single source of
    // truth (mutations append/update it, so it must start complete)
    if (effectiveFolders.length > 0) {
      setFolders(effectiveFolders);
    }

    // Build pages from saved config (healing stale/duplicate/folder-contained
    // entries) or from scratch on first launch — same reconciliation either
    // way. Every known app counts, including those discovered inside a
    // physical subfolder: on a first launch their converted folder contains
    // them, but once ungrouped they are loose on the saved pages, and a
    // reseed that only knew the top-level apps dropped them from the grid.
    setPages(
      buildInitialPages(
        orderConfig?.pages ?? [],
        [...appsMap.keys()],
        effectiveFolders
      )
    );
  }

  // Build items from current order
  const items = buildItems(order);

  const activeItem = activeId
    ? items.find((i) => i.data.id === activeId) ?? null
    : null;

  const itemIds = items.map((item) => item.data.id);

  return {
    items,
    itemIds,
    activeItem,
    appsMap,
    getItemType,
  };
}
