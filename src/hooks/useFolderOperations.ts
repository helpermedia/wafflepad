import { useState } from "react";
import type { AppInfo, FolderInfo, FolderMetadata } from "@/types/app";
import {
  dissolveFolder,
  isFolderId,
  removeAppFromFolder,
  updateFolderById,
} from "@/utils/folderUtils";
import { removeManyFromPages, replaceInPages } from "@/utils/pageUtils";
import { categoryDisplayName, sharedNamePrefix } from "@/utils/appUtils";
import type { GridFolder } from "@/components/items/FolderItem";

interface UseFolderOperationsOptions {
  folders: FolderMetadata[];
  setFolders: React.Dispatch<React.SetStateAction<FolderMetadata[]>>;
  createNewFolder: (appPaths: string[], name?: string) => FolderMetadata;
  appsMap: Map<string, AppInfo>;
  /** The folders on disk discovery found apps in, for naming */
  physicalFolders: FolderInfo[];
  /** Current page structure of the main grid (see pageUtils) */
  pages: string[][];
  /** Make a page structure current (persisted by useGrid) */
  setPages: (pages: string[][]) => void;
}

export function useFolderOperations({
  folders,
  setFolders,
  createNewFolder,
  appsMap,
  physicalFolders,
  pages,
  setPages,
}: UseFolderOperationsOptions) {
  // Only the id is state — name/apps of the open folder are derived live in
  // useGrid from folders + appsMap, so there is a single source of truth
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  // Id of a folder created this session whose modal should open in rename
  // mode (Launchpad-style: new folder name is immediately editable)
  const [newFolderId, setNewFolderId] = useState<string | null>(null);

  function handleOpenFolder(folder: GridFolder) {
    setNewFolderId(null);
    setOpenFolderId(folder.id);
  }

  function handleCloseFolder() {
    setNewFolderId(null);
    setOpenFolderId(null);
  }

  function handleRenameFolder(folderId: string, newName: string) {
    const updatedFolders = updateFolderById(folders, folderId, { name: newName });
    setFolders(updatedFolders);
  }

  function handleFolderOrderChange(folderId: string, newOrder: string[]) {
    const updatedFolders = updateFolderById(folders, folderId, { appPaths: newOrder });
    setFolders(updatedFolders);
  }

  /** The name a folder of these apps gets: the folder on disk they all
   *  come from, whoever put them there having grouped them on purpose;
   *  else the App Store category at least half of them declare (a tie
   *  goes to the first), like Launchpad; else the name they share
   *  ("Microsoft" for Word and Excel, see sharedNamePrefix); else the
   *  category any of them declares, a guess beating "Untitled" with the
   *  name about to be edited; none if nothing applies */
  function suggestFolderName(appIds: string[]): string | undefined {
    // Built here, once per folder created, rather than on every render
    const physicalFolderNames = new Map(
      physicalFolders.flatMap((folder) => folder.apps.map((app) => [app.path, folder.name]))
    );
    const fromDisk = appIds.map((id) => physicalFolderNames.get(id));
    const diskFolder = fromDisk[0];
    if (diskFolder && fromDisk.every((name) => name === diskFolder)) return diskFolder;

    const counts = new Map<string, number>();
    for (const id of appIds) {
      const name = categoryDisplayName(appsMap.get(id)?.category);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let plurality: string | undefined;
    let pluralityCount = 0;
    for (const [name, count] of counts) {
      if (count > pluralityCount) {
        plurality = name;
        pluralityCount = count;
      }
    }
    if (plurality && pluralityCount >= Math.ceil(appIds.length / 2)) return plurality;

    const names = appIds.flatMap((id) => appsMap.get(id)?.name ?? []);
    return sharedNamePrefix(names) ?? plurality;
  }

  /** The apps behind grid ids: an app id is itself, a folder id stands
   *  for its apps (the folder merges into the operation's target) */
  function appsBehind(ids: string[]): { appIds: string[]; folderIds: string[] } {
    const appIds: string[] = [];
    const folderIds: string[] = [];
    for (const id of ids) {
      const folder = isFolderId(id) ? folders.find((f) => f.id === id) : undefined;
      if (folder) {
        folderIds.push(id);
        appIds.push(...folder.appPaths);
      } else {
        appIds.push(id);
      }
    }
    return { appIds: [...new Set(appIds)], folderIds };
  }

  /**
   * Fold grid items into a new folder: apps join it, folders among them
   * merge into it. The folder takes the anchor's slot (a drop's target,
   * or the tile a selection's menu was shown on) and the others leave
   * their pages. Opens the folder with its name in edit mode, like
   * Launchpad.
   */
  function handleCreateFolderFrom(ids: string[], anchorId: string) {
    const { appIds, folderIds } = appsBehind(ids);
    if (appIds.length === 0) return;

    const newFolder = createNewFolder(appIds, suggestFolderName(appIds));
    if (folderIds.length > 0) {
      const merged = new Set(folderIds);
      setFolders((prev) => prev.filter((f) => !merged.has(f.id)));
    }

    // Open modal in rename mode
    setNewFolderId(newFolder.id);
    setOpenFolderId(newFolder.id);

    const leavers = ids.filter((id) => id !== anchorId);
    setPages(replaceInPages(removeManyFromPages(pages, leavers), anchorId, [newFolder.id]));
  }

  /** Drag-and-drop folder creation: the dragged app joins the target's
   *  slot, and the target's category names the folder before its own */
  function handleCreateFolder(sourceAppId: string, targetAppId: string) {
    handleCreateFolderFrom([targetAppId, sourceAppId], targetAppId);
  }

  /**
   * Move grid items into an existing folder: apps join it, folders among
   * them merge into it, and all of them leave their pages. Opens the
   * folder, as a drop into it does.
   */
  function handleMoveToFolder(folderId: string, ids: string[]) {
    if (!folders.some((f) => f.id === folderId)) return;
    // The target is never a source: it must neither merge into itself nor
    // leave its page
    const sources = ids.filter((id) => id !== folderId);
    const { appIds, folderIds } = appsBehind(sources);
    if (appIds.length === 0) return;

    const merged = new Set(folderIds);
    setFolders((prev) =>
      prev
        .filter((f) => !merged.has(f.id))
        .map((f) =>
          f.id === folderId ? { ...f, appPaths: [...new Set([...f.appPaths, ...appIds])] } : f
        )
    );

    // Open folder modal
    setOpenFolderId(folderId);

    setPages(removeManyFromPages(pages, sources));
  }

  /** Drag-and-drop into a folder tile: the dragged app joins it */
  function handleAddToFolder(folderId: string, appId: string) {
    handleMoveToFolder(folderId, [appId]);
  }

  function handleRemoveFromFolder(appId: string) {
    if (!openFolderId) return;
    if (!folders.some((f) => f.id === openFolderId)) return;

    const { newPages, updatedFolders, dissolved } = removeAppFromFolder(
      openFolderId, appId, pages, folders,
    );

    setFolders(updatedFolders);
    setPages(newPages);

    if (dissolved) {
      setOpenFolderId(null);
    }
  }

  /** Dissolve a folder back into the grid: its apps take its slot on its
   *  page (context-menu Ungroup) */
  function handleUngroupFolder(folderId: string) {
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;

    const { newPages, updatedFolders } = dissolveFolder(
      folderId, pages, folders, folder.appPaths,
    );
    setFolders(updatedFolders);
    setPages(newPages);
  }

  function getOpenFolderSavedOrder(): string[] | undefined {
    if (!openFolderId) return undefined;
    return folders.find((f) => f.id === openFolderId)?.appPaths;
  }

  return {
    openFolderId,
    setOpenFolderId,
    newFolderId,
    handleOpenFolder,
    handleCloseFolder,
    handleRenameFolder,
    handleFolderOrderChange,
    handleRemoveFromFolder,
    handleCreateFolder,
    handleCreateFolderFrom,
    handleAddToFolder,
    handleMoveToFolder,
    handleUngroupFolder,
    getOpenFolderSavedOrder,
  };
}
