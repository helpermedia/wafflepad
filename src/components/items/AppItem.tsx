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
  /** Selection highlight: the keyboard cursor or a multi-selection */
  isSelected?: boolean;
  /** Set false to render as a plain launch tile (search results) */
  draggable?: boolean;
}) {
  // Outlines the icon while its context menu is open (like the Apps app);
  // popup() resolves when the menu closes, either by action or dismissal
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
        isLaunching && "animate-launch-grow",
        isSelected && "bg-white/15"
      )}
    >
      <div className="relative" data-drag-handle>
        <DropTarget action={dropAction ?? null} />
        {isMenuOpen && (
          // The ring draws outward from this box, wrapping the icon's visible
          // squircle with no gap (like the Apps app). Geometry measured from
          // the cached icon PNGs: 256px canvas, 24px transparent margin, ~55px
          // corner, which at the 96px render is a 9px inset and 20px radius.
          // accent = the user's system accent color
          <div className="absolute inset-2.25 rounded-[20px] ring-3 ring-accent pointer-events-none" />
        )}
        <Icon icon={item.icon} alt={item.name} />
      </div>
      <Label>{item.name}</Label>
    </Container>
  );
}
