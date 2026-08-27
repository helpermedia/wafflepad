import { useState } from "react";
import { cn } from "@/utils/cn";
import { Container } from "@/components/ui/Container";
import { Icon } from "@/components/ui/Icon";
import { Label } from "@/components/ui/Label";
import { DropTarget } from "@/components/items/DropTarget";
import { showAppContextMenu } from "@/utils/appContextMenu";
import type { AppInfo } from "@/types/app";
import type { DropAction } from "@/hooks/useFolderCreation";

export type GridItem = AppInfo & { id: string };

export function AppItem({
  item,
  isDragActive,
  isDragging,
  dropAction,
  onLaunch,
  onCloseApp,
  isLaunching,
  isSelected,
  draggable = true,
}: {
  item: GridItem;
  isDragActive: boolean;
  isDragging: boolean;
  dropAction?: DropAction;
  onLaunch?: (path: string) => void;
  /** Closes the launcher after a context menu action hands off to another app */
  onCloseApp?: () => void;
  isLaunching?: boolean;
  /** Targeted by the keyboard cursor or a multi-selection: shown like
   *  an open context menu's tile */
  isSelected?: boolean;
  /** Set false to render as a plain launch tile (search results) */
  draggable?: boolean;
}) {
  // Marks the tile while its context menu is open; popup() resolves when
  // the menu closes, either by action or dismissal
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Targeted (the keyboard cursor, a multi-selection, an open context
  // menu): Finder's selection look, a translucent well behind the icon
  // and the name on an accent pill
  const targeted = isMenuOpen || isSelected;

  function handleClick() {
    // Only launch if not currently dragging
    if (!isDragActive && onLaunch) {
      onLaunch(item.path);
    }
  }

  async function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (isDragActive) return;
    setIsMenuOpen(true);
    try {
      await showAppContextMenu(item, {
        onOpen: () => onLaunch?.(item.path),
        onCloseApp: () => onCloseApp?.(),
      });
    } finally {
      setIsMenuOpen(false);
    }
  }

  return (
    <Container
      data-draggable={draggable ? true : undefined}
      data-id={item.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "relative",
        // Transition for smooth shifting during drag
        isDragActive && "transition-transform duration-200",
        // Hide original when being dragged (ghost is visible instead)
        isDragging && "opacity-0 pointer-events-none",
        // Grow animation when launching
        isLaunching && "animate-launch-grow"
      )}
    >
      <div className="relative" data-drag-handle>
        <DropTarget action={dropAction ?? null} />
        {targeted && (
          // Behind the icon (earlier in the DOM), 8px outside its visible
          // squircle, like Finder's: the icon PNGs inset that squircle 9px
          // in the 96px box (256px canvas, 24px transparent margin), so the
          // well sits 1px inside the box. The backdrop is as light or dark
          // as the wallpaper behind the blur, so the translucent white fill
          // (which carries dark wallpapers) gets a faint dark hairline that
          // carries light ones and vanishes on dark. Left out of drag
          // ghosts, a ghost being the item moving, not a targeted one.
          <div
            data-ghost-exclude
            className="absolute inset-px rounded-2xl bg-white/15 ring-1 ring-black/20 pointer-events-none"
          />
        )}
        <Icon icon={item.icon} alt={item.name} />
      </div>
      <Label highlighted={targeted}>{item.name}</Label>
    </Container>
  );
}
