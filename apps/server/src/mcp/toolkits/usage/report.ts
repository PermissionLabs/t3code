import { IsoDateTime, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const USAGE_REPORT_DRIVERS = ["codex", "claudeAgent", "antigravity"] as const;
export type UsageReportDriver = (typeof USAGE_REPORT_DRIVERS)[number];

export const DEFAULT_MAX_AGE_SEC = 3_600;

export const UsageUnavailableReason = Schema.Literals([
  "notConfigured",
  "disabled",
  "notInstalled",
  "unauthenticated",
  "notLoaded",
  "unsupported",
  "probeFailed",
  "stale",
  "noWindows",
]);
export type UsageUnavailableReason = typeof UsageUnavailableReason.Type;

const UsageWindowReport = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  remainingFraction: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationSec: Schema.optional(Schema.Number),
});

export const ProviderUsageReport = Schema.Struct({
  provider: Schema.Literals(USAGE_REPORT_DRIVERS),
  instanceId: Schema.optional(Schema.String),
  status: Schema.Literals(["ok", "unavailable"]),
  unavailableReason: Schema.optional(UsageUnavailableReason),
  windows: Schema.Array(UsageWindowReport),
  observedAt: Schema.optional(IsoDateTime),
});
export type ProviderUsageReport = typeof ProviderUsageReport.Type;

const unavailable = (
  provider: UsageReportDriver,
  reason: UsageUnavailableReason,
  extra: { readonly instanceId?: string; readonly observedAt?: string } = {},
): ProviderUsageReport => ({
  provider,
  ...extra,
  status: "unavailable",
  unavailableReason: reason,
  windows: [],
});

/**
 * Builds the report field by field from T3's cached snapshot. Never spread a source object here:
 * snapshots also carry auth email, workspace ids, credential fingerprints and probe messages.
 */
function reportInstance(
  provider: UsageReportDriver,
  snapshot: ServerProvider,
  nowMs: number,
  maxAgeMs: number,
): ProviderUsageReport {
  const instanceId = snapshot.instanceId as string;
  if (!snapshot.enabled || snapshot.status === "disabled") {
    return unavailable(provider, "disabled", { instanceId });
  }
  if (!snapshot.installed) return unavailable(provider, "notInstalled", { instanceId });
  if (snapshot.auth.status === "unauthenticated") {
    return unavailable(provider, "unauthenticated", { instanceId });
  }
  const limits = snapshot.usageLimits;
  // Absent while the first probe runs and right after an account change clears the old bars.
  if (limits === undefined) return unavailable(provider, "notLoaded", { instanceId });
  const observedAt = limits.checkedAt;
  if (limits.unavailable?.reason === "unsupported") {
    return unavailable(provider, "unsupported", { instanceId, observedAt });
  }
  if (limits.windows.length === 0) {
    return unavailable(provider, limits.unavailable ? "probeFailed" : "noWindows", {
      instanceId,
      observedAt,
    });
  }
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMs) {
    return unavailable(provider, "stale", { instanceId, observedAt });
  }
  const windows = limits.windows.flatMap((window) => {
    const resetsMs = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
    // A window whose reset already passed describes a period that no longer exists.
    if (resetsMs !== undefined && (!Number.isFinite(resetsMs) || resetsMs <= nowMs)) return [];
    const usedPercent = Number.isFinite(window.usedPercent)
      ? Math.min(100, Math.max(0, window.usedPercent))
      : undefined;
    if (usedPercent === undefined) return [];
    return [
      {
        id: window.id,
        label: window.label,
        kind: window.kind,
        remainingFraction: Math.round((100 - usedPercent) * 100) / 10_000,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(window.windowDurationMins === undefined
          ? {}
          : { windowDurationSec: window.windowDurationMins * 60 }),
      },
    ];
  });
  if (windows.length === 0) return unavailable(provider, "stale", { instanceId, observedAt });
  return { provider, instanceId, status: "ok", windows, observedAt };
}

export function buildProviderUsageReport(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly requested?: ReadonlyArray<UsageReportDriver> | undefined;
  readonly nowMs: number;
  readonly maxAgeSec?: number | undefined;
}): ReadonlyArray<ProviderUsageReport> {
  const maxAgeMs = (input.maxAgeSec ?? DEFAULT_MAX_AGE_SEC) * 1_000;
  const requested = input.requested?.length ? [...new Set(input.requested)] : USAGE_REPORT_DRIVERS;
  return requested.flatMap((provider) => {
    const instances = input.providers.filter((snapshot) => snapshot.driver === provider);
    if (instances.length === 0) return [unavailable(provider, "notConfigured")];
    return instances.map((snapshot) => reportInstance(provider, snapshot, input.nowMs, maxAgeMs));
  });
}
