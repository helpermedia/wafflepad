import type { AppInfo, FolderInfo, FolderMetadata } from "@/types/app";
import { appendToLastPage, removeFromPages, replaceInPages } from "@/utils/pageUtils";

const FOLDER_PREFIX = "folder://";

export function generateFolderId(): string {
  return `${FOLDER_PREFIX}${crypto.randomUUID()}`;
}

export function isFolderId(id: string): boolean {
  return id.startsWith(FOLDER_PREFIX);
}

export function getFolderUUID(id: string): string | null {
  if (!isFolderId(id)) return null;
  return id.slice(FOLDER_PREFIX.length);
}

export function createFolder(
  appPaths: string[],
  name: string = "Untitled"
): FolderMetadata {
  return {
    id: generateFolderId(),
    name,
    appPaths,
    createdAt: Date.now(),
  };
}

export function resolveFolderApps(
  appPaths: string[],
  appsMap: Map<string, AppInfo>
): AppInfo[] {
  return appPaths
    .map((path) => appsMap.get(path))
    .filter((app): app is AppInfo => app !== undefined);
}

/**
 * Resolve an ordered list of IDs into app items, skipping unknown IDs.
 */
export function resolveOrderToAppItems(
  order: string[],
  appsMap: Map<string, AppInfo>
): (AppInfo & { id: string })[] {
  return order
    .map((id) => {
      const app = appsMap.get(id);
      return app ? { ...app, id } : null;
    })
    .filter((item): item is AppInfo & { id: string } => item !== null);
}

/** Folder apps a scan could not verify, kept aside for the save (see
 *  healFolders): by folder id for folders that stay live, whole for
 *  folders that had nothing else */
export interface RetainedFolderApps {
  byFolder: Map<string, string[]>;
  wholeFolders: FolderMetadata[];
}

export const NO_RETAINED_FOLDER_APPS: RetainedFolderApps = {
  byFolder: new Map(),
  wholeFolders: [],
};

/**
 * Drop apps that no longer exist on disk from folder contents, and drop
 * folders left with no apps at all. Heals configs referencing uninstalled
 * apps: phantom entries would otherwise desync FolderModal reorders (DOM
 * indices vs order array) and an all-apps-gone folder would render as a
 * permanent empty tile that can never be dissolved. An app under a
 * directory the scan could not read is unverified rather than gone: it
 * leaves the live folders all the same, but is retained for the save to
 * put back (withRetainedFolderApps), so a failed scan cannot silently
 * unfold it.
 */
export function healFolders(
  folders: FolderMetadata[],
  knownAppPaths: ReadonlySet<string>,
  unreadableDirs: readonly string[] = []
): { folders: FolderMetadata[]; retained: RetainedFolderApps } {
  const prefixes = unreadableDirs.map((dir) => (dir.endsWith("/") ? dir : `${dir}/`));
  const unverified = (path: string) => prefixes.some((prefix) => path.startsWith(prefix));
  const live: FolderMetadata[] = [];
  const retained: RetainedFolderApps = { byFolder: new Map(), wholeFolders: [] };
  for (const folder of folders) {
    const known = folder.appPaths.filter((p) => knownAppPaths.has(p));
    const kept = folder.appPaths.filter((p) => !knownAppPaths.has(p) && unverified(p));
    if (known.length > 0) {
      live.push({ ...folder, appPaths: known });
      if (kept.length > 0) retained.byFolder.set(folder.id, kept);
    } else if (kept.length > 0) {
      retained.wholeFolders.push({ ...folder, appPaths: kept });
    }
  }
  return { folders: live, retained };
}

/**
 * The folders as they should be saved: what the session holds, plus what
 * a failed scan left unverified (see healFolders). A retained folder the
 * session dissolved stays dissolved; its unverified apps come back loose
 * on the next complete scan, as newly discovered apps do.
 */
export function withRetainedFolderApps(
  folders: FolderMetadata[],
  retained: RetainedFolderApps
): FolderMetadata[] {
  if (retained.byFolder.size === 0 && retained.wholeFolders.length === 0) return folders;
  const liveIds = new Set(folders.map((f) => f.id));
  const merged = folders.map((f) => {
    const kept = retained.byFolder.get(f.id);
    if (!kept) return f;
    const present = new Set(f.appPaths);
    return { ...f, appPaths: [...f.appPaths, ...kept.filter((p) => !present.has(p))] };
  });
  return [...merged, ...retained.wholeFolders.filter((f) => !liveIds.has(f.id))];
}

/**
 * Build the initial pages from the saved pages and the discovered items:
 * reconciles the saved arrangement with what is installed now. Drops ids
 * that no longer exist, apps that live inside folders and repeated ids
 * (every id appears once — keys and drag indices depend on it), then
 * appends newly discovered items to the last page, from where the paged
 * layout cascades them onto further pages as capacity requires. A page
 * left empty is retired by the caller's commit.
 */
export function buildInitialPages(
  savedPages: string[][],
  appPaths: string[],
  folders: FolderMetadata[]
): string[][] {
  const folderContained = new Set(folders.flatMap((f) => f.appPaths));
  const allIds = new Set([
    ...appPaths.filter((path) => !folderContained.has(path)),
    ...folders.map((f) => f.id),
  ]);

  const seen = new Set<string>();
  const pages = savedPages.map((page) =>
    page.filter((id) => {
      if (!allIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
  );
  const newItems = [...allIds].filter((id) => !seen.has(id));
  return newItems.length > 0 ? appendToLastPage(pages, newItems) : pages;
}

/**
 * Dissolve a folder back into individual apps: they take the folder's
 * slot on its page (which overflows forward if they don't fit).
 */
export function dissolveFolder(
  folderId: string,
  pages: string[][],
  currentFolders: FolderMetadata[],
  appsToInsert: string[]
): { newPages: string[][]; updatedFolders: FolderMetadata[] } {
  // Drop any stray copies of the inserted apps so they can't end up twice
  const inserted = new Set(appsToInsert);
  const cleaned = pages.map((page) => page.filter((id) => !inserted.has(id)));
  const newPages = replaceInPages(cleaned, folderId, appsToInsert);
  const updatedFolders = currentFolders.filter((f) => f.id !== folderId);
  return { newPages, updatedFolders };
}

/**
 * Remove an app from a folder and compute the resulting pages/folders.
 * If the folder has 0-1 apps remaining, it is dissolved (apps return to the grid).
 * Otherwise the folder is updated and the removed app joins the last page.
 */
export function removeAppFromFolder(
  folderId: string,
  appId: string,
  pages: string[][],
  folders: FolderMetadata[],
): { newPages: string[][]; updatedFolders: FolderMetadata[]; dissolved: boolean } {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return { newPages: pages, updatedFolders: folders, dissolved: false };

  const remainingApps = folder.appPaths.filter((id) => id !== appId);

  if (remainingApps.length <= 1) {
    const { newPages, updatedFolders } = dissolveFolder(
      folderId, pages, folders, [...remainingApps, appId],
    );
    return { newPages, updatedFolders, dissolved: true };
  }

  const updatedFolders = updateFolderById(folders, folderId, { appPaths: remainingApps });
  // Remove first: the app must never appear twice in the grid
  const newPages = appendToLastPage(removeFromPages(pages, appId), [appId]);
  return { newPages, updatedFolders, dissolved: false };
}

/**
 * Return a new folders array with one folder updated by id.
 */
export function updateFolderById(
  folders: FolderMetadata[],
  id: string,
  updates: Partial<FolderMetadata>
): FolderMetadata[] {
  return folders.map((f) => (f.id === id ? { ...f, ...updates } : f));
}

/**
 * Convert physical folders (from disk) to FolderMetadata format.
 * Used on first launch to initialize folders from filesystem.
 */
export function convertPhysicalFolders(folders: FolderInfo[]): FolderMetadata[] {
  return folders.map((folder) => ({
    id: generateFolderId(),
    name: folder.name,
    appPaths: folder.apps.map((app) => app.path),
    createdAt: Date.now(),
  }));
}
