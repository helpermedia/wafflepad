# helper-dnd

A lightweight, framework-agnostic drag-and-drop library for grid sorting with macOS Launchpad-style center-crossing detection.

## Features

- **Center-crossing detection**: Items shift only when the dragged item's center crosses a target's center
- **Direction-aware**: Only triggers shifts in the direction you're moving
- **60fps performance**: Direct DOM manipulation during drag, no framework re-renders
- **GPU-accelerated**: Uses `translate3d` for smooth animations
- **Touch support**: Built on Pointer Events API for mouse, touch, and pen
- **Multi-grid support**: Seamlessly hand off drags between containers
- **Framework-agnostic**: Plain TypeScript, works with React, Vue, Svelte, or vanilla JS
- **Tiny footprint**: ~5KB minified, zero dependencies

## Quick Start

### HTML Setup

Add `data-draggable` to sortable items and `data-drag-handle` to the drag handle area:

```html
<div id="grid">
  <div data-draggable data-id="item-1">
    <div data-drag-handle>
      <img src="icon.png" />
    </div>
    <span>Label</span>
  </div>
  <!-- more items... -->
</div>
```

The drag ghost is a clone of the item. Mark anything that should not travel with it (a selection or focus ring, for instance) with `data-ghost-exclude`, and the clone drops it.

### Basic Usage

```typescript
import { DragEngine } from 'helper-dnd';

const container = document.getElementById('grid');
const engine = new DragEngine(container);

engine.on('onDragEnd', (fromIndex, toIndex) => {
  if (fromIndex !== toIndex) {
    // Reorder your data array
    const items = [...yourItems];
    const [removed] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, removed);
    // Update your state/render
  }
});

engine.enable();

// Cleanup when done
engine.destroy();
```

### React Integration

```tsx
import { useEffect, useRef, useState } from 'react';
import { DragEngine } from 'helper-dnd';

function SortableGrid({ items, onReorder }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new DragEngine(container);

    engine.on('onDragStart', (item) => {
      setActiveId(item.id);
    });

    engine.on('onDragEnd', (fromIndex, toIndex) => {
      setActiveId(null);
      if (fromIndex !== toIndex) {
        onReorder(fromIndex, toIndex);
      }
    });

    engine.on('onDragCancel', () => {
      setActiveId(null);
    });

    engine.enable();
    return () => engine.destroy();
  }, [onReorder]);

  return (
    <div ref={containerRef} className="grid">
      {items.map((item) => (
        <div
          key={item.id}
          data-draggable
          data-id={item.id}
          className={activeId === item.id ? 'is-dragging' : ''}
        >
          <div data-drag-handle>
            <img src={item.icon} />
          </div>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Your Application                             │
│  - State management                                              │
│  - Renders items                                                 │
│  - Updates state on drop                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ container ref, callbacks
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DragEngine                                   │
│  - Pointer event handling (PointerTracker)                       │
│  - Ghost element management (GhostElement)                       │
│  - Slot detection (SlotDetection)                                │
│  - Visual shifts (GridTransforms)                                │
│  - NO framework dependencies                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Why Direct DOM Manipulation?

**During drag (60fps):**
- DragEngine handles all visual updates
- Direct CSS transforms (GPU-accelerated)
- No state changes, no re-renders
- Smooth 60fps feedback

**On drop (once):**
- DragEngine emits final indices
- Your app updates state
- Framework re-renders with new order

## API Reference

### DragEngine

The main orchestrator that coordinates all sub-modules.

```typescript
import { DragEngine } from 'helper-dnd';

const engine = new DragEngine(container, options);
```

#### Options

```typescript
interface DragOptions {
  /** Minimum pixels to move before drag starts (default: 5) */
  activationDistance?: number;

  /** Duration of shift animation in ms (default: 200) */
  shiftDuration?: number;

  /** Icon size in pixels for hit detection (default: 96) */
  iconSize?: number;

  /** CSS class applied to ghost element (default: 'drag-ghost') */
  ghostClass?: string;

  /** CSS class applied to item being dragged (default: 'is-dragging') */
  draggingClass?: string;
}
```

#### Methods

```typescript
// Start listening for drags
engine.enable(): void;

// Stop listening and cleanup
engine.destroy(): void;

// Subscribe to events
engine.on(event, handler): void;
engine.off(event): void;

// Get current drag state (null if not dragging)
engine.getState(): DragState | null;

// Get cached grid items
engine.getItems(): GridItem[];

// Get container element
engine.getContainer(): HTMLElement;

// Cancel current drag (for programmatic cancellation)
engine.cancel(preserveGhost?: boolean): void;

// Start drag at specific element (for multi-grid handoff)
engine.startDragAt(element, pointer, existingGhost?): void;

// Get/detach ghost element (for multi-grid handoff)
engine.getGhostElement(): HTMLElement | null;
engine.detachGhost(): HTMLElement | null;
```

#### Events

```typescript
interface DragEvents {
  /** Fired when drag starts */
  onDragStart?: (item: GridItem) => void;

  /** Fired on every pointer move during drag */
  onDragMove?: (state: DragState) => void;

  /** Fired when target index changes (items shift) */
  onIndexChange?: (fromIndex: number, toIndex: number) => void;

  /** Fired when drag ends (drop) */
  onDragEnd?: (fromIndex: number, toIndex: number) => void;

  /** Fired when drag is cancelled */
  onDragCancel?: () => void;

  /**
   * Control drop animation target.
   * Return { center, duration } for custom animation.
   * Return null to skip animation (instant).
   * Return undefined for default behavior.
   */
  getDropAnimationTarget?: (state: DragState) => DropAnimationTarget | null | undefined;
}
```

### Types

```typescript
interface Point {
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  center: Point;
}

interface GridItem {
  id: string;
  element: HTMLElement;
  rect: Rect;
  index: number;
}

interface DragState {
  activeItem: GridItem;
  startPointer: Point;     // viewport frame
  currentPointer: Point;   // viewport frame
  previousPointer: Point;  // viewport frame
  activeCenter: Point;     // drag-start frame (includes scrollDelta)
  targetIndex: number;
  scrollDelta: number;     // host scroll accumulated since drag start
}

interface DropAnimationTarget {
  center: Point;           // viewport frame
  duration?: number;
}
```

#### Coordinate Frames

Item positions are cached once at drag start, so two coordinate frames
coexist while the scroll host moves during a drag:

- **Drag-start frame** — `GridItem.rect`, `DragState.activeCenter`, and
  `getSlotCenter()`. Compare these against each other only.
- **Viewport frame** — the `DragState` pointer fields and any `center`
  returned from `getDropAnimationTarget` (the ghost animates in the
  viewport).

`scrollDelta` bridges them: `startFrameY = viewportY + scrollDelta`.
Mixing frames without it produces silently wrong targeting once the user
scrolls mid-drag.

### DragCoordinator

Coordinates drag handoff between multiple grids (e.g., main grid and folder modal).

```typescript
import { DragCoordinator } from 'helper-dnd';

const coordinator = new DragCoordinator({
  onHandoff: async (request) => {
    // Update your app state (e.g., close folder, add item to target)
    await updateStateAndWaitForRender();
  }
});

// Register grids
coordinator.register({ id: 'main', engine: mainEngine, container: mainEl });
coordinator.register({ id: 'folder', engine: folderEngine, container: folderEl });

// In your drag move handler, check for boundary exit
const targetGrid = coordinator.checkBoundaries(pointer);
if (targetGrid) {
  await coordinator.handoff(targetGrid, itemId, pointer);
}

// Cleanup
coordinator.destroy();
```

## Styling

### Required CSS

```css
/* Hide original item while dragging */
.is-dragging {
  opacity: 0;
  pointer-events: none;
}

/* Optional: Ghost shadow */
.drag-ghost {
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}
```

### Visual Behavior

| Element | Property | Value |
|---------|----------|-------|
| Ghost | Opacity | 0.85 |
| Ghost | Scale | 1.02 |
| Ghost | Z-index | 10000 |
| Shifting items | Transition | 200ms cubic-bezier(0.2, 0, 0, 1) |

## Advanced Usage

### Custom Drop Animation

Skip the default drop animation (e.g., when adding to folder):

```typescript
engine.on('getDropAnimationTarget', (state) => {
  if (shouldSkipAnimation) {
    return null; // Ghost destroyed immediately
  }
  // Use default animation
  return undefined;
});
```

### Icon-Only Drag Handles

Only the area with `data-drag-handle` initiates drag. This allows labels to be selectable:

```html
<div data-draggable data-id="app-1">
  <div data-drag-handle>  <!-- Only this area triggers drag -->
    <img src="icon.png" />
  </div>
  <span>Selectable Label</span>  <!-- Can be selected/clicked -->
</div>
```

### Edge Auto-Scroll

When the grid lives inside a scrollable container, dragging within 80px of
the container's top or bottom edge scrolls it continuously, speed easing up
toward the edge. The engine finds the nearest scrollable ancestor
automatically and keeps slot detection accurate across scrolling (manual
wheel scrolling mid-drag included). Configure or disable via options:

```typescript
new DragEngine(container, {
  autoScroll: true,        // default
  autoScrollEdgeSize: 80,  // px from edge where scrolling engages
  autoScrollMaxSpeed: 16,  // px per frame at the deepest point
});
```

### Multi-Grid Handoff

When dragging from a folder to the main grid:

```typescript
// In folder's onDragMove
engine.on('onDragMove', (state) => {
  const targetGrid = coordinator.checkBoundaries(state.currentPointer);
  if (targetGrid && targetGrid !== 'folder') {
    coordinator.handoff(targetGrid, state.activeItem.id, state.currentPointer);
  }
});
```

## Technical Details

### Why Pointer Events?

- **Unified API**: Mouse, touch, and pen with one interface
- **Pointer capture**: Reliable tracking even when pointer leaves element
- **Native touch**: Better than bolted-on touch event handling
- **Modern standard**: Supported in all browsers

### Why translate3d?

- **GPU acceleration**: Composited on GPU, no layout thrashing
- **Consistent performance**: Smooth 60fps even with many items
- **No reflow**: Transform doesn't trigger expensive layout recalculation

### Center-Crossing Algorithm

Items shift when:
1. The dragged item's center crosses another item's center
2. The crossing is in the direction of movement (prevents jitter)
3. The items are in the same row/column (using `iconSize` for tolerance)

This matches macOS Launchpad / iOS home screen behavior exactly.

## Sub-Modules

For advanced usage, individual modules can be imported:

```typescript
import {
  DragEngine,
  DragCoordinator,
  PointerTracker,
  GhostElement,
  SlotDetection,
  GridTransforms,
} from 'helper-dnd';
```

## Browser Support

- Chrome 55+
- Firefox 59+
- Safari 13+
- Edge 79+

Requires Pointer Events API support.

## License

MIT
