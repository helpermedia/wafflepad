import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

interface LabelProps {
  children: ReactNode;
  /** Targeted tile: the name on an accent pill, as Finder shows a
   *  selected item's */
  highlighted?: boolean;
}

/**
 * A tile's name, up to two lines. The text sits in a box that hugs it
 * (a pill's width for one line, the tile's for two), so a highlight
 * wraps the words the way Finder's does, and turning it on never shifts
 * the layout.
 */
export function Label({ children, highlighted = false }: LabelProps) {
  return (
    <span className="mt-1 block w-full text-center text-xs leading-normal text-white">
      <span
        className={cn(
          "line-clamp-2 mx-auto w-fit max-w-full rounded-md px-1.5",
          // A drag ghost is the item moving, not a targeted one: plain there
          highlighted && "bg-accent [.drag-ghost_&]:bg-transparent"
        )}
      >
        {children}
      </span>
    </span>
  );
}
