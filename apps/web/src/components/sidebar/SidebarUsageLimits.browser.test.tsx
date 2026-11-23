import "~/index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarUsageLimits } from "./SidebarUsageLimits";
import {
  resolveSidebarUsageLimitsMaxHeight,
  SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT,
  SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY,
  SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
} from "./useSidebarUsageLimitsHeight";

const checkedAt = "2026-10-25T16:00:00.000Z";

interface FakePresentation {
  readonly connection: { readonly phase: "connected" };
  readonly entry: { readonly target: { readonly label: string } };
  readonly serverConfig: { readonly providers: readonly ServerProvider[] };
}

const state = vi.hoisted(() => ({
  presentations: new Map<EnvironmentId, FakePresentation>(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.presentations,
}));

vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => "2026-10-25T16:00",
}));

vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    presentationsWithProvidersAtom: {},
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    refreshProviders: {},
  },
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => false,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

function makeProvider(
  driver: "codex" | "claudeAgent" | "antigravity" | "cursor" | "opencode",
  instanceId: string,
  windows: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly usedPercent: number;
  }>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: windows.map((window) => ({
        id: window.id,
        kind: "session" as const,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: "2026-10-25T20:00:00.000Z",
      })),
    },
  };
}

function setup(providers: readonly ServerProvider[], storedHeight: string | null = null) {
  state.presentations = new Map([
    [
      EnvironmentId.make("local"),
      {
        connection: { phase: "connected" },
        entry: { target: { label: "Local" } },
        serverConfig: { providers },
      },
    ],
  ]);
  const previous = localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY);
  if (storedHeight === null) {
    localStorage.removeItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY);
  } else {
    localStorage.setItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY, storedHeight);
  }
  return {
    [Symbol.dispose]() {
      if (previous === null) {
        localStorage.removeItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY);
      } else {
        localStorage.setItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY, previous);
      }
    },
  };
}

const MANY_PROVIDERS: readonly ServerProvider[] = [
  makeProvider("codex", "codex", [
    { id: "5h", label: "5-hour", usedPercent: 20 },
    { id: "7d", label: "7-day", usedPercent: 35 },
  ]),
  makeProvider("claudeAgent", "claude", [
    { id: "5h", label: "5-hour", usedPercent: 45 },
    { id: "7d", label: "7-day", usedPercent: 60 },
  ]),
  makeProvider("antigravity", "antigravity", [
    { id: "gemini-flash", label: "Gemini Flash", usedPercent: 10 },
    { id: "3p-shared", label: "Claude & GPT (shared)", usedPercent: 25 },
  ]),
  makeProvider("cursor", "cursor", [
    { id: "apiPercentUsed", label: "API", usedPercent: 15 },
    { id: "autoPercentUsed", label: "Auto", usedPercent: 5 },
  ]),
];

const SINGLE_PROVIDER: readonly ServerProvider[] = [
  makeProvider("codex", "codex", [{ id: "5h", label: "5-hour", usedPercent: 20 }]),
];

function renderLimits() {
  return render(
    <SidebarProvider>
      <div style={{ width: 256 }}>
        <SidebarUsageLimits />
      </div>
    </SidebarProvider>,
  );
}

async function dragHandle(handle: HTMLElement, fromY: number, toY: number) {
  // Synthetic pointer events have no active browser pointer to capture.
  using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
  const pointer = { bubbles: true, pointerId: 1, button: 0 };
  await act(() => {
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: fromY }));
    handle.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientY: toY }));
    handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: toY }));
  });
}

describe("SidebarUsageLimits vertical resize", () => {
  it("defaults to 160px maxHeight without adding empty whitespace for short lists", async () => {
    using _storage = setup(SINGLE_PROVIDER);
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const list = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;
    const expectedMax = resolveSidebarUsageLimitsMaxHeight(window.innerHeight);

    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.getAttribute("aria-label")).toBe("Resize subscription limits");
    expect(separator.getAttribute("aria-valuenow")).toBe(
      String(SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT),
    );
    expect(separator.getAttribute("aria-valuemin")).toBe(String(SIDEBAR_USAGE_LIMITS_MIN_HEIGHT));
    expect(separator.getAttribute("aria-valuemax")).toBe(String(expectedMax));
    expect(list.style.maxHeight).toBe(`${SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT}px`);
    expect(list.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(list.getBoundingClientRect().height).toBeLessThan(
      SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT,
    );
  });

  it("expands, shrinks, and clamps within min/max bounds on drag", async () => {
    using _storage = setup(MANY_PROVIDERS);
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const list = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;
    const expectedMax = resolveSidebarUsageLimitsMaxHeight(window.innerHeight);

    expect(Math.round(list.getBoundingClientRect().height)).toBe(
      SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT,
    );

    // Drag up 100px -> expands from 160px to 260px
    await dragHandle(separator, 500, 400);
    expect(list.style.maxHeight).toBe("260px");
    expect(separator.getAttribute("aria-valuenow")).toBe("260");
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe("260");

    // Drag down 120px from rendered height
    const renderedBeforeShrink = list.getBoundingClientRect().height;
    const expectedAfterShrink = Math.max(
      SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
      Math.round(renderedBeforeShrink - 120),
    );
    await dragHandle(separator, 400, 520);
    expect(list.style.maxHeight).toBe(`${expectedAfterShrink}px`);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe(
      String(expectedAfterShrink),
    );

    // Drag far down -> clamps to minimum height
    await dragHandle(separator, 500, 900);
    expect(list.style.maxHeight).toBe(`${SIDEBAR_USAGE_LIMITS_MIN_HEIGHT}px`);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe(
      String(SIDEBAR_USAGE_LIMITS_MIN_HEIGHT),
    );

    // Drag far up -> clamps to viewport-bounded maximum height
    await dragHandle(separator, 500, -500);
    expect(list.style.maxHeight).toBe(`${expectedMax}px`);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe(String(expectedMax));
  });

  it("anchors drag calculations to rendered height when maxHeight exceeds content height", async () => {
    using _storage = setup(MANY_PROVIDERS.slice(0, 2), "420");
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const list = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;

    const renderedHeight = list.getBoundingClientRect().height;
    expect(renderedHeight).toBeGreaterThan(SIDEBAR_USAGE_LIMITS_MIN_HEIGHT);
    expect(renderedHeight).toBeLessThan(300);
    expect(list.style.maxHeight).toBe("420px");

    await dragHandle(separator, 500, 530);
    const expectedHeight = Math.max(
      SIDEBAR_USAGE_LIMITS_MIN_HEIGHT,
      Math.round(renderedHeight - 30),
    );
    expect(list.style.maxHeight).toBe(`${expectedHeight}px`);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe(
      String(expectedHeight),
    );
  });

  it("ignores stationary clicks and resets to default on double-click", async () => {
    using _storage = setup(MANY_PROVIDERS);
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const list = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;

    await dragHandle(separator, 500, 500);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBeNull();

    await dragHandle(separator, 500, 400);
    expect(list.style.maxHeight).toBe("260px");
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe("260");

    await act(() => {
      separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(list.style.maxHeight).toBe(`${SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT}px`);
    expect(separator.getAttribute("aria-valuenow")).toBe(
      String(SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT),
    );
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBeNull();
  });

  it("supports keyboard resizing via ArrowUp, ArrowDown, Home, and End", async () => {
    using _storage = setup(MANY_PROVIDERS);
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const list = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;
    const expectedMax = resolveSidebarUsageLimitsMaxHeight(window.innerHeight);

    await act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(list.style.maxHeight).toBe("176px");
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe("176");

    await act(() => {
      separator.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }),
      );
    });
    expect(list.style.maxHeight).toBe("224px");

    await act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(list.style.maxHeight).toBe("208px");

    await act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(list.style.maxHeight).toBe(`${SIDEBAR_USAGE_LIMITS_MIN_HEIGHT}px`);

    await act(() => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(list.style.maxHeight).toBe(`${expectedMax}px`);
  });

  it("restores persisted height across remount and falls back safely on corrupt storage", async () => {
    using _storage = setup(MANY_PROVIDERS);
    await using screen = await renderLimits();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    await dragHandle(separator, 500, 380);
    expect(localStorage.getItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY)).toBe("280");
    await screen.unmount();

    await using restored = await renderLimits();
    const restoredList = restored.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;
    expect(restoredList.style.maxHeight).toBe("280px");
    await restored.unmount();

    using _error = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(SIDEBAR_USAGE_LIMITS_HEIGHT_STORAGE_KEY, "not-valid-json");
    await using fallback = await renderLimits();
    const fallbackList = fallback.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-usage-limits-list"]',
    )!;
    expect(fallbackList.style.maxHeight).toBe(`${SIDEBAR_USAGE_LIMITS_DEFAULT_MAX_HEIGHT}px`);
  });
});
