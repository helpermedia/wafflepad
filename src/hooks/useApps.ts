import { use, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, FolderInfo } from "@/types/app";
import { getAppsPromise } from "@/lib/appsApi";

interface UseAppsResult {
  apps: AppInfo[];
  folders: FolderInfo[];
  unreadableDirs: string[];
}

export function useApps(): UseAppsResult {
  // use() suspends until the promise resolves - data is available immediately after
  const initialData = use(getAppsPromise());

  // State for progressive icon updates
  const [apps, setApps] = useState(initialData.apps);
  const [folders, setFolders] = useState(initialData.folders);
  const iconsLoadedRef = useRef(false);

  // Load icons progressively after initial render, batching state updates
  useEffect(() => {
    if (iconsLoadedRef.current) return;
    iconsLoadedRef.current = true;

    const allApps = [
      ...initialData.apps,
      ...initialData.folders.flatMap((folder) => folder.apps),
    ];
    const appsWithoutIcons = allApps.filter((app) => !app.icon);
    if (appsWithoutIcons.length === 0) return;

    // Accumulate loaded icons, flush in batches to reduce re-renders
    const pendingIcons = new Map<string, string>();
    let remaining = appsWithoutIcons.length;
    let cancelled = false;

    function flush() {
      if (cancelled || pendingIcons.size === 0) return;
      const batch = new Map(pendingIcons);
      pendingIcons.clear();

      setApps((prev) =>
        prev.map((a) => {
          const icon = batch.get(a.path);
          return icon ? { ...a, icon } : a;
        })
      );
      setFolders((prev) =>
        prev.map((folder) => ({
          ...folder,
          apps: folder.apps.map((a) => {
            const icon = batch.get(a.path);
            return icon ? { ...a, icon } : a;
          }),
        }))
      );
    }

    const interval = setInterval(flush, 100);

    for (const app of appsWithoutIcons) {
      invoke<string | null>("get_app_icon", { path: app.path })
        .then((icon) => {
          if (icon) pendingIcons.set(app.path, icon);
        })
        .catch((e) => console.error(`Failed to load icon for ${app.path}:`, e))
        .finally(() => {
          remaining--;
          if (remaining === 0) {
            clearInterval(interval);
            flush();
          }
        });
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [initialData]);

  return { apps, folders, unreadableDirs: initialData.unreadableDirs };
}
