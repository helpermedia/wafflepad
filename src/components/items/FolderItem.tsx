import { useRef, useState } from "react";
import { getIconSrc } from "@/utils/iconUtils";
import { cn } from "@/utils/cn";
import { Container } from "@/components/ui/Container";
import { Label } from "@/components/ui/Label";
import { DropTarget } from "@/components/items/DropTarget";
import { showFolderContextMenu } from "@/utils/folderContextMenu";
import type { AppInfo } from "@/types/app";
import type { DropAction } from "@/hooks/useFolderCreation";

export interface GridFolder {
  id: string;
  name: string;
  apps: AppInfo[];
}

/** Preview density tiers: capacity and the grid classes that render it */
const PREVIEW_TIERS = [
  { capacity: 4, classes: "grid-cols-2 grid-rows-2" },
  { capacity: 9, classes: "grid-cols-3 grid-rows-3" },
  { capacity: 16, classes: "grid-cols-4 grid-rows-4" },
];

export function FolderPreview({ apps, tinted = false }: { apps: AppInfo[]; tinted?: boolean }) {
  // Density follows the folder size; anything past the largest tier's
  // capacity isn't represented
  const tier =
    PREVIEW_TIERS.find((t) => apps.length <= t.capacity) ??
    PREVIEW_TIERS[PREVIEW_TIERS.length - 1];
  const previewApps = apps.slice(0, tier.capacity);

  return (
    <div
      className={cn(
        "relative w-24 h-24 bg-white/20 rounded-2xl p-2 grid gap-1 border border-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]",
        tier.classes
      )}
    >
      {tinted && (
        // A targeted folder shows its selection on the box itself, a wash of
        // the accent color under the mini icons (positioned, so they paint
        // above it). Left out of drag ghosts, a ghost being the item
        // moving, not a targeted one.
        <div
          data-ghost-exclude
          className="absolute inset-0 rounded-2xl bg-accent opacity-30 pointer-events-none"
        />
      )}
      {previewApps.map((app) =>
        app.icon ? (
          <img
            key={app.path}
            src={getIconSrc(app.icon)}
            alt={app.name}
            className="relative w-full h-full object-contain rounded-md"
            draggable={false}
          />
        ) : (
          // Soft placeholder cell while (or if) the icon never generates —
          // the full-size skeleton SVG is near-invisible at mini scale
          <div key={app.path} className="relative w-full h-full rounded-md bg-white/15" />
        )
      )}
    </div>
  );
}

/**
 * Finder-style inline rename field, shown in the label's place. Mounted
 * only while renaming, so it owns its draft and focuses on mount. Enter or
 * blur commits, Escape cancels; reports null when the name is unchanged or
 * empty.
 */
function RenameInput({
  name,
  onDone,
}: {
  name: string;
  onDone: (newName: string | null) => void;
}) {
  const [value, setValue] = useState(name);
  const didFocusRef = useRef(false);
  // Enter commits and unmounts the input; should that unmount also fire
  // blur, the second report must be a no-op
  const doneRef = useRef(false);

  function finish(newName: string | null) {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(newName);
  }

  function commit() {
    const trimmed = value.trim();
    finish(trimmed && trimmed !== name ? trimmed : null);
  }

  return (
    <input
      ref={(node) => {
        if (node && !didFocusRef.current) {
          didFocusRef.current = true;
          node.focus();
          node.select();
        }
      }}
      type="text"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          // Stops at the React root, so the host's document-level Escape
          // (which would close the launcher) never sees this press
          e.stopPropagation();
          finish(null);
        }
      }}
      // select-text: body-level select-none leaks into WebKit form
      // controls (SearchField opts back in the same way)
      className="mt-1 w-full select-text rounded-md bg-black/40 px-1 text-center text-xs leading-normal text-white outline-none ring-2 ring-accent"
    />
  );
}

export function FolderItem({
  item,
  isDragActive,
  isDragging,
  dropAction,
  onOpen,
  onUngroup,
  isRenaming,
  onRenameStart,
  onRenameEnd,
  isSelected,
}: {
  item: GridFolder;
  isDragActive: boolean;
  isDragging: boolean;
  dropAction?: DropAction;
  onOpen: (folder: GridFolder) => void;
  /** Dissolves the folder back into the grid (context menu) */
  onUngroup: (folder: GridFolder) => void;
  /** Inline rename live on this tile. Host-owned state: the host guards
   *  Escape, click-outside and search focus around it */
  isRenaming: boolean;
  /** Context-menu Rename chosen */
  onRenameStart: (folder: GridFolder) => void;
  /** Rename finished; newName is null when cancelled or unchanged */
  onRenameEnd: (folder: GridFolder, newName: string | null) => void;
  /** Targeted by the keyboard cursor or a multi-selection: shown like
   *  an open context menu's tile */
  isSelected?: boolean;
}) {
  // Marks the tile while its context menu is open (same as AppItem)
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Targeted (the keyboard cursor, a multi-selection, an open context
  // menu): the preview box tints with the accent color and the name goes
  // on the accent pill (an app tile gets a well behind its icon instead,
  // see AppItem)
  const targeted = isMenuOpen || isSelected;

  const handleClick = () => {
    // Only open if no drag is in progress (same guard as AppItem)
    if (!isDragActive) {
      onOpen(item);
    }
  };

  async function handleContextMenu(e: React.MouseEvent) {
    // The rename input keeps the WebView's edit menu — its only paste path
    // (see main.tsx)
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
    if (isDragActive) return;
    setIsMenuOpen(true);
    try {
      await showFolderContextMenu(item.id, {
        onOpen: () => onOpen(item),
        onRename: () => onRenameStart(item),
        onUngroup: () => onUngroup(item),
      });
    } finally {
      setIsMenuOpen(false);
    }
  }

  return (
    <Container
      data-draggable
      data-id={item.id}
      onContextMenu={handleContextMenu}
      className={cn(
        "relative",
        // Transition for smooth shifting during drag
        isDragActive && "transition-transform duration-200",
        // Hide original when being dragged (ghost is visible instead)
        isDragging && "opacity-0 pointer-events-none"
      )}
    >
      <div className="relative" data-drag-handle onClick={handleClick}>
        <DropTarget action={dropAction ?? null} />
        <FolderPreview apps={item.apps} tinted={targeted} />
      </div>
      {isRenaming ? (
        <RenameInput name={item.name} onDone={(newName) => onRenameEnd(item, newName)} />
      ) : (
        <Label highlighted={targeted}>{item.name}</Label>
      )}
    </Container>
  );
}
