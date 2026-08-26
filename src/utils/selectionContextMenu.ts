import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface FolderOption {
  id: string;
  name: string;
}

export interface SelectionContextMenuCallbacks {
  /** Fold the selection into a new folder */
  onNewFolder: () => void;
  /** Move the selection into an existing folder */
  onMoveToFolder: (folderId: string) => void;
}

type MenuAction = "new-folder" | "move-to-folder";

// Mirrors appContextMenu: the menu itself is native (show_selection_menu)
// and the choice comes back as a "selection-menu-action" event. The
// callbacks are bound to the selection the menu was shown for, and kept
// after dismissal, since the action event can arrive after the popup call
// resolves.
let current: SelectionContextMenuCallbacks | null = null;
let actionListener: Promise<unknown> | null = null;

function handleAction(action: MenuAction, folderId: string | null) {
  if (!current) return;
  if (action === "new-folder") {
    current.onNewFolder();
  } else if (folderId) {
    current.onMoveToFolder(folderId);
  }
}

/** Show the native right-click menu for a multi-selection at the cursor
 *  position: a new folder from it, or a move into one of `folders` */
export async function showSelectionContextMenu(
  count: number,
  folders: FolderOption[],
  callbacks: SelectionContextMenuCallbacks
) {
  current = callbacks;

  try {
    actionListener ??= listen<{ action: MenuAction; folderId: string | null }>(
      "selection-menu-action",
      (event) => handleAction(event.payload.action, event.payload.folderId)
    );
    await actionListener;
  } catch (e) {
    actionListener = null; // retry the registration on the next attempt
    console.error("Failed to listen for selection menu actions:", e);
    return;
  }

  try {
    // Resolves when the menu is dismissed
    await invoke("show_selection_menu", { count, folders });
  } catch (e) {
    console.error("Failed to show selection context menu:", e);
  }
}
