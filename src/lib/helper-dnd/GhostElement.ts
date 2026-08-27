import type { Point } from "./types";

interface GhostOptions {
  /** Opacity of ghost (default: 0.85) */
  opacity?: number;
  /** Scale of ghost (default: 1.02) */
  scale?: number;
  /** CSS class to add */
  className?: string;
}

/**
 * Manages the visual drag preview that follows the pointer.
 *
 * Responsibilities:
 * - Create a clone of the dragged item
 * - Position it to follow the pointer
 * - Apply visual styling (opacity, scale, shadow)
 * - Clean up on drag end
 */
export class GhostElement {
  private element: HTMLElement | null = null;
  private offset: Point = { x: 0, y: 0 };
  private options: Required<GhostOptions>;

  private static DEFAULTS: Required<GhostOptions> = {
    opacity: 0.85,
    scale: 1.02,
    className: "drag-ghost",
  };

  constructor(options: GhostOptions = {}) {
    this.options = { ...GhostElement.DEFAULTS, ...options };
  }

  /** Create ghost from source element */
  create(source: HTMLElement, initialPointer: Point): void {
    const rect = source.getBoundingClientRect();

    // Calculate offset from pointer to element origin
    this.offset = {
      x: rect.left - initialPointer.x,
      y: rect.top - initialPointer.y,
    };

    // Clone the element
    this.element = source.cloneNode(true) as HTMLElement;

    // Apply ghost styling
    Object.assign(this.element.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      pointerEvents: "none",
      zIndex: "10000",
      opacity: String(this.options.opacity),
      transform: this.getTransform(initialPointer),
      // Remove any existing transitions for immediate response
      transition: "none",
      // Ensure it's above everything
      isolation: "isolate",
    });

    this.element.classList.add(this.options.className);

    // Remove any IDs to avoid duplicates
    this.element.removeAttribute("id");
    this.element.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));

    // Remove data-draggable to prevent the ghost from being detected as a drag target
    this.element.removeAttribute("data-draggable");

    // Drop what the source marks as not belonging on a ghost (a selection
    // or focus ring: the ghost is the moving item, not a targeted one)
    this.element.querySelectorAll("[data-ghost-exclude]").forEach((el) => el.remove());

    document.body.appendChild(this.element);
  }

  /** Update ghost position (called on every pointer move) */
  updatePosition(pointer: Point): void {
    if (!this.element) return;
    this.element.style.transform = this.getTransform(pointer);
  }

  /** Remove ghost from DOM */
  destroy(): void {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  /**
   * Adopt an existing ghost element from another engine.
   * Used during drag handoff to maintain visual continuity.
   *
   * @param existingElement - The ghost element to adopt
   * @param currentPointer - Current pointer position for offset calculation
   */
  adopt(existingElement: HTMLElement, currentPointer: Point): void {
    // Clean up any existing ghost first (but don't destroy the one we're adopting)
    if (this.element && this.element !== existingElement) {
      this.element.remove();
    }

    // Adopt the existing element
    this.element = existingElement;

    // Recalculate offset based on current position and pointer
    // The ghost uses transform for positioning, so we need to parse it
    const rect = existingElement.getBoundingClientRect();
    this.offset = {
      x: rect.left - currentPointer.x,
      y: rect.top - currentPointer.y,
    };

    // Update styling to match this engine's options
    this.element.style.opacity = String(this.options.opacity);
    this.element.classList.add(this.options.className);
  }

  /**
   * Animate ghost to target center position, then destroy.
   * Returns a Promise that resolves when animation completes.
   */
  animateTo(targetCenter: Point, duration: number = 200): Promise<void> {
    return new Promise((resolve) => {
      if (!this.element) {
        resolve();
        return;
      }

      // Calculate target position (ghost uses top-left, so adjust from center)
      const targetX = targetCenter.x - this.element.offsetWidth / 2;
      const targetY = targetCenter.y - this.element.offsetHeight / 2;

      // Enable smooth transition
      this.element.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;

      // Animate to target position (scale back to 1)
      this.element.style.transform = `translate3d(${targetX}px, ${targetY}px, 0) scale(1)`;

      // Clean up after animation
      setTimeout(() => {
        if (this.element) {
          this.destroy();
        }
        resolve();
      }, duration);
    });
  }

  /** Get the current ghost element (for external access if needed) */
  getElement(): HTMLElement | null {
    return this.element;
  }

  /**
   * Detach and return the ghost element, transferring ownership to caller.
   * After calling this, the GhostElement instance no longer manages the element,
   * so destroy() will not remove it from the DOM.
   * Used during drag handoff to preserve the ghost across engine switches.
   */
  detach(): HTMLElement | null {
    const element = this.element;
    this.element = null;
    return element;
  }

  private getTransform(pointer: Point): string {
    const x = pointer.x + this.offset.x;
    const y = pointer.y + this.offset.y;
    return `translate3d(${x}px, ${y}px, 0) scale(${this.options.scale})`;
  }
}
