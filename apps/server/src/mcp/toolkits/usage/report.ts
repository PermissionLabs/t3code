import {
  IsoDateTime,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
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
  windowDurationSource: Schema.optional(Schema.Literals(["provider", "known_constant"])),
  pace: Schema.Struct({
    computable: Schema.Boolean,
    reason: Schema.optional(
      Schema.Literals(["missingResetsAt", "missingWindowDuration", "notStarted"]),
    ),
  }),
});
type UsageWindowReport = typeof UsageWindowReport.Type;

export const ProviderUsageReport = Schema.Struct({
  provider: Schema.Literals(USAGE_REPORT_DRIVERS),
  instanceId: Schema.optional(Schema.String),
  status: Schema.Literals(["ok", "unavailable"]),
  unavailableReason: Schema.optional(UsageUnavailableReason),
  windows: Schema.Array(UsageWindowReport),
  observedAt: Schema.optional(IsoDateTime),
});
export type ProviderUsageReport = typeof ProviderUsageReport.Type;

const FIVE_HOURS_SEC = 5 * 3_600;
const WEEK_SEC = 7 * 24 * 3_600;

const KIND_LABEL: Record<ServerProviderUsageWindow["kind"], string> = {
  session: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Quota",
};

interface KnownWindow {
  readonly id: string;
  readonly label?: string;
  readonly durationSec?: number;
}

const CLAUDE_MODEL_FAMILIES = ["Opus", "Sonnet", "Haiku", "Fable"] as const;

/**
 * Provider ids, labels and model display names are free-form and can carry account details, so
 * output ids and labels come only from this table; anything else gets an ordinal id.
 */
const KNOWN_WINDOWS: Record<UsageReportDriver, Readonly<Record<string, KnownWindow>>> = {
  codex: {
    primary: { id: "codex:primary" },
    secondary: { id: "codex:secondary" },
    individual: { id: "codex:individual", label: "Monthly credit limit" },
  },
  claudeAgent: {
    five_hour: { id: "claude:five_hour", label: "Session", durationSec: FIVE_HOURS_SEC },
    seven_day: { id: "claude:seven_day", label: "Weekly", durationSec: WEEK_SEC },
    monthly_spend: { id: "claude:monthly_spend", label: "Monthly spend" },
    ...Object.fromEntries(
      CLAUDE_MODEL_FAMILIES.map((family) => [
        `seven_day_${family.toLowerCase()}`,
        {
          id: `claude:seven_day_model:${family.toLowerCase()}`,
          label: `Weekly · ${family}`,
          durationSec: WEEK_SEC,
        },
      ]),
    ),
  },
  antigravity: {
    "gemini-5h": {
      id: "antigravity:gemini_5h",
      label: "Gemini · 5-hour",
      durationSec: FIVE_HOURS_SEC,
    },
    "gemini-weekly": {
      id: "antigravity:gemini_weekly",
      label: "Gemini · Weekly",
      durationSec: WEEK_SEC,
    },
    "3p-5h": {
      id: "antigravity:shared_3p_5h",
      label: "Claude & GPT (shared) · 5-hour",
      durationSec: FIVE_HOURS_SEC,
    },
    "3p-weekly": {
      id: "antigravity:shared_3p_weekly",
      label: "Claude & GPT (shared) · Weekly",
      durationSec: WEEK_SEC,
    },
    "gemini-quota": { id: "antigravity:gemini_quota", label: "Gemini · Reported quota" },
    "claude-quota": { id: "antigravity:claude_quota", label: "Claude · Reported quota" },
    "claude-weekly": {
      id: "antigravity:claude_weekly",
      label: "Claude · Weekly",
      durationSec: WEEK_SEC,
    },
    "gpt-quota": { id: "antigravity:gpt_quota", label: "GPT · Reported quota" },
    "gpt-weekly": { id: "antigravity:gpt_weekly", label: "GPT · Weekly", durationSec: WEEK_SEC },
  },
};

const ID_PREFIX: Record<UsageReportDriver, string> = {
  codex: "codex",
  claudeAgent: "claude",
  antigravity: "antigravity",
};

function makeWindowNamer(provider: UsageReportDriver) {
  const ordinals = new Map<string, number>();
  return (window: ServerProviderUsageWindow): KnownWindow & { readonly label: string } => {
    const known = Object.hasOwn(KNOWN_WINDOWS[provider], window.id)
      ? KNOWN_WINDOWS[provider][window.id]
      : undefined;
    if (known) return { ...known, label: known.label ?? KIND_LABEL[window.kind] };
    const modelScoped = provider === "claudeAgent" && window.id.startsWith("seven_day_");
    const group = modelScoped ? "model_scoped" : window.kind;
    const ordinal = (ordinals.get(group) ?? 0) + 1;
    ordinals.set(group, ordinal);
    return {
      id: `${ID_PREFIX[provider]}:${group}:${ordinal}`,
      label: modelScoped ? "Weekly · Other model" : KIND_LABEL[window.kind],
    };
  };
}

function paceOf(
  usedPercent: number,
  resetsAt: string | undefined,
  durationSec: number | undefined,
): UsageWindowReport["pace"] {
  // Rolling windows that were never used report no reset; they start on first use.
  if (resetsAt === undefined) {
    return {
      computable: false,
      reason: usedPercent === 0 && durationSec !== undefined ? "notStarted" : "missingResetsAt",
    };
  }
  if (durationSec === undefined) return { computable: false, reason: "missingWindowDuration" };
  return { computable: true };
}

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
  const nameWindow = makeWindowNamer(provider);
  const windows = limits.windows.flatMap((window): ReadonlyArray<UsageWindowReport> => {
    const resetsMs = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
    // A window whose reset already passed describes a period that no longer exists.
    if (resetsMs !== undefined && (!Number.isFinite(resetsMs) || resetsMs <= nowMs)) return [];
    const usedPercent = Number.isFinite(window.usedPercent)
      ? Math.min(100, Math.max(0, window.usedPercent))
      : undefined;
    if (usedPercent === undefined) return [];
    const { id, label, durationSec: knownSec } = nameWindow(window);
    const snapshotSec = window.windowDurationMins ? window.windowDurationMins * 60 : undefined;
    const durationSec = snapshotSec ?? knownSec;
    // Only Codex reports lengths; Claude sends none and Antigravity names a cadence we convert.
    const durationSource =
      snapshotSec !== undefined && provider === "codex" ? "provider" : "known_constant";
    return [
      {
        id,
        label,
        kind: window.kind,
        remainingFraction: Math.round((100 - usedPercent) * 100) / 10_000,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(durationSec === undefined
          ? {}
          : { windowDurationSec: durationSec, windowDurationSource: durationSource }),
        pace: paceOf(usedPercent, window.resetsAt, durationSec),
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
