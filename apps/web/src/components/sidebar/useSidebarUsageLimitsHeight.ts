import * as Schema from "effect/Schema";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useViewportSize } from "../../hooks/useViewportSize";

export const SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY = "t3code:sidebar:usage-limits-max-height";
export const SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT = 160;
export const SIDEBAR_USAGE_LIMITS_MIN_HEIGHT = 80;
const SIDEBAR_USAGE_LIMITS_MAX_HEIGHT_CAP = 560;
const SIDEBAR_USAGE_LIMITS_VIEWPORT_RATIO = 0.6;
const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 48;
const DRAG_MOVE_THRESHOLD_PX = 2;

const HeightSchema = Schema.Finite;

interface HeightBounds {
  readonly min: number;
  readonly max: number;
}

interface VerticalResizeSession {
  readonly startHeight: number;
  bounds: HeightBounds;
  readonly resize: (height: number) => number;
  readonly finish: (height: number, moved: boolean) => void;
  readonly cleanup?: (committed: boolean) => void;
}

interface ActiveVerticalDrag {
  readonly session: VerticalResizeSession;
  readonly target: HTMLDivElement;
  readonly pointerId: number;
  readonly startY: number;
  pendingY: number;
  height: number;
  moved: boolean;
  frame: number | null;
  readonly onBlur: () => void;
}

export function resolveSidebarUsageLimitsMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT;
  }
  return Math.max(
    SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
    Math.min(
      SIDEBAR_USAGE_LIMITS_MAX_HEIGHT_CAP,
      Math.floor(viewportHeight * SIDEBAR_USAGE_LIMITS_VIEWPORT_RATIO),
    ),
  );
}

function clampHeight(value: number, bounds: HeightBounds): number {
  const finite = Number.isFinite(value) ? value : SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(finite)));
}

function readStoredHeight(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = getLocalStorageItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY, HeightSchema);
    if (stored === null) return null;
    return clampHeight(stored, {
      min: SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
      max: SIDEBAR_USAGE_LIMITS_MAX_HEIGHT_CAP,
    });
  } catch (error) {
    console.error("Could not read persisted sidebar limits height.", error);
    return null;
  }
}

function createVerticalResizeDrag() {
  let drag: ActiveVerticalDrag | null = null;

  const flush = () => {
    const active = drag;
    if (!active) return;
    const delta = active.startY - active.pendingY;
    if (Math.abs(delta) > DRAG_MOVE_THRESHOLD_PX) active.moved = true;
    if (!active.moved) return;
    active.height = active.session.resize(
      clampHeight(active.session.startHeight + delta, active.session.bounds),
    );
  };

  const finish = (commit: boolean) => {
    const active = drag;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    window.removeEventListener("blur", active.onBlur);
    if (commit) flush();
    // Release can synchronously dispatch lostpointercapture.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {}
    delete active.target.dataset.dragging;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.height, active.moved);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>, usePosition: boolean) => {
    const active = drag;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingY = event.clientY;
    finish(true);
  };

  return {
    ref: (node: HTMLDivElement | null) => (node === null ? undefined : () => finish(false)),
    refresh(bounds: HeightBounds) {
      if (!drag) return;
      drag.session.bounds = bounds;
      flush();
    },
    begin(
      event: ReactPointerEvent<HTMLDivElement>,
      start: (event: ReactPointerEvent<HTMLDivElement>) => VerticalResizeSession | null,
    ) {
      if (event.button !== 0 || drag) return;
      const session = start(event);
      if (!session) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const onBlur = () => finish(true);
      window.addEventListener("blur", onBlur);
      event.currentTarget.dataset.dragging = "true";
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startY: event.clientY,
        pendingY: event.clientY,
        height: session.startHeight,
        moved: false,
        frame: null,
        onBlur,
      };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingY = event.clientY;
      if (Math.abs(event.clientY - active.startY) > DRAG_MOVE_THRESHOLD_PX) active.moved = true;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => end(event, true),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => end(event, false),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => end(event, false),
  };
}

export function useSidebarUsageLimitsHeight() {
  const { height: viewportHeight } = useViewportSize();
  const maxHeightLimit = resolveSidebarUsageLimitsMaxHeight(viewportHeight);
  const bounds: HeightBounds = {
    min: SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
    max: maxHeightLimit,
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const [storedHeight, setStoredHeight] = useState<number | null>(readStoredHeight);
  const effectiveMaxHeight = clampHeight(
    storedHeight ?? SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT,
    bounds,
  );

  const restoreHeight = useStableCallback(
    (listElement: HTMLDivElement | null, target: HTMLDivElement) => {
      if (listElement) {
        listElement.style.maxHeight = `${effectiveMaxHeight}px`;
      }
      target.setAttribute("aria-valuenow", String(effectiveMaxHeight));
    },
  );

  const commitHeight = useStableCallback((nextHeight: number) => {
    const clamped = clampHeight(nextHeight, bounds);
    setStoredHeight(clamped);
    try {
      setLocalStorageItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY, clamped, HeightSchema);
    } catch (error) {
      console.error("Could not persist sidebar limits height.", error);
    }
  });

  const resetHeight = () => {
    setStoredHeight(null);
    try {
      removeLocalStorageItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY);
    } catch (error) {
      console.error("Could not reset persisted sidebar limits height.", error);
    }
  };

  // Created once: `ref` must keep its identity, or a re-render mid-drag would run its cleanup.
  const [drag] = useState(createVerticalResizeDrag);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reapplies the live drag pointer position to the DOM before paint when viewport bounds change
  useLayoutEffect(
    () => drag.refresh({ min: SIDEBAR_USAGE_LIMITS_MIN_HEIGHT, max: maxHeightLimit }),
    [drag, maxHeightLimit],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.begin(event, (pointerDownEvent) => {
      const target = pointerDownEvent.currentTarget;
      const listElement = listRef.current;
      const measuredHeight = listElement?.getBoundingClientRect().height ?? 0;
      const startHeight =
        measuredHeight > 0 ? Math.min(maxHeightLimit, measuredHeight) : effectiveMaxHeight;

      return {
        startHeight,
        bounds,
        resize(nextHeight) {
          if (listElement) {
            listElement.style.maxHeight = `${nextHeight}px`;
          }
          target.setAttribute("aria-valuenow", String(nextHeight));
          return nextHeight;
        },
        finish(finalHeight, moved) {
          if (moved) commitHeight(finalHeight);
          else restoreHeight(listElement, target);
        },
        cleanup(committed) {
          if (!committed) restoreHeight(listElement, target);
        },
      };
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
    let nextHeight: number;
    switch (event.key) {
      case "ArrowUp":
        nextHeight = effectiveMaxHeight + step;
        break;
      case "ArrowDown":
        nextHeight = effectiveMaxHeight - step;
        break;
      case "Home":
        nextHeight = SIDEBAR_USAGE_LIMITS_MIN_HEIGHT;
        break;
      case "End":
        nextHeight = maxHeightLimit;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    commitHeight(nextHeight);
  };

  return {
    listRef,
    maxHeight: effectiveMaxHeight,
    minHeight: SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
    maxHeightLimit,
    handleProps: {
      ref: drag.ref,
      onPointerDown: handlePointerDown,
      onPointerMove: drag.onPointerMove,
      onPointerUp: drag.onPointerUp,
      onPointerCancel: drag.onPointerCancel,
      onLostPointerCapture: drag.onLostPointerCapture,
      onDoubleClick: resetHeight,
      onKeyDown: handleKeyDown,
    },
  };
}
