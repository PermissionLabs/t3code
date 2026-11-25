import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { deriveInstanceId } from "../../../../../../packages/client-runtime/src/providerInstanceIds.ts";
import { modelWindows, summaryWindows } from "../../../provider/antigravityUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../../../provider/claudeUsageLimits.ts";
import { codexRateLimitsToLimits } from "../../../provider/codexUsageLimits.ts";
import { buildProviderUsageReport } from "./report.ts";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

const SECRETS = [
  "person@example.com",
  "workspace-secret-id",
  "profile-secret-id",
  "fingerprint-secret",
  "credit-secret-id",
  "https://usage.example.com/secret",
  "probe failed: Bearer sk-secret-token",
];

const snapshot = (
  driver: string,
  overrides: Partial<ServerProvider> & { readonly usageLimits?: ServerProviderUsageLimits } = {},
): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(driver),
  displayName: "Personal account",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  message: "probe failed: Bearer sk-secret-token",
  checkedAt: "2026-11-24T11:59:00.000Z",
  auth: {
    status: "authenticated",
    email: "person@example.com",
    label: "person@example.com",
    workspaceId: "workspace-secret-id",
    profileId: "profile-secret-id",
  },
  models: [],
  skills: [],
  slashCommands: [],
  ...overrides,
});

const limits = (overrides: Partial<ServerProviderUsageLimits> = {}): ServerProviderUsageLimits => ({
  checkedAt: "2026-11-24T11:50:00.000Z",
  credentialFingerprint: "fingerprint-secret",
  resetCredits: { availableCount: 1, nextCreditId: "credit-secret-id" },
  externalUsage: { label: "Usage", url: "https://usage.example.com/secret" },
  windows: [
    {
      id: "primary",
      kind: "session",
      label: "Session",
      usedPercent: 37.5,
      resetsAt: "2026-11-24T14:00:00.000Z",
      windowDurationMins: 300,
    },
    { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 100 },
  ],
  ...overrides,
});

describe("buildProviderUsageReport", () => {
  it("maps cached windows to remaining fractions without leaking account or credential data", () => {
    const report = buildProviderUsageReport({
      providers: [snapshot("codex", { usageLimits: limits() })],
      requested: ["codex"],
      nowMs: NOW,
    });

    expect(report).toEqual([
      {
        provider: "codex",
        instance: "codex:1",
        status: "ok",
        observedAt: "2026-11-24T11:50:00.000Z",
        windows: [
          {
            id: "codex:primary",
            label: "Session",
            kind: "session",
            remainingFraction: 0.625,
            resetsAt: "2026-11-24T14:00:00.000Z",
            windowDurationSec: 18_000,
            windowDurationSource: "provider",
            pace: { computable: true },
          },
          {
            id: "codex:secondary",
            label: "Weekly",
            kind: "weekly",
            remainingFraction: 0,
            pace: { computable: false, reason: "missingResetsAt" },
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(report);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/email|fingerprint|credit|workspace|profile|displayName|url/i);
  });

  it("reports every requested provider, and only those, once per instance", () => {
    const report = buildProviderUsageReport({
      providers: [
        snapshot("codex", { usageLimits: limits() }),
        snapshot("codex", { instanceId: ProviderInstanceId.make("codex-work") }),
        snapshot("cursor", { usageLimits: limits() }),
      ],
      nowMs: NOW,
    });

    expect(report.map(({ provider, instance, status }) => [provider, instance, status])).toEqual([
      ["codex", "codex:1", "ok"],
      ["codex", "codex:2", "unavailable"],
      ["claudeAgent", undefined, "unavailable"],
      ["antigravity", undefined, "unavailable"],
    ]);
  });

  it.each([
    ["no instance", undefined, "notConfigured"],
    ["disabled", { enabled: false, usageLimits: limits() }, "disabled"],
    ["not installed", { installed: false }, "notInstalled"],
    ["signed out", { auth: { status: "unauthenticated" as const } }, "unauthenticated"],
    ["loading or account just changed", {}, "notLoaded"],
    [
      "unsupported",
      { usageLimits: limits({ windows: [], unavailable: { reason: "unsupported" } }) },
      "unsupported",
    ],
    [
      "probe failed",
      {
        usageLimits: limits({
          windows: [],
          unavailable: { reason: "probeFailed", message: "probe failed: Bearer sk-secret-token" },
        }),
      },
      "probeFailed",
    ],
    ["no windows", { usageLimits: limits({ windows: [] }) }, "noWindows"],
    [
      "observed too long ago",
      { usageLimits: limits({ checkedAt: "2026-11-24T10:59:59.000Z" }) },
      "stale",
    ],
    [
      "every window already reset",
      {
        usageLimits: limits({
          windows: [
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: 90,
              resetsAt: "2026-11-24T11:00:00.000Z",
            },
          ],
        }),
      },
      "stale",
    ],
  ] as const)("reports %s as unavailable without windows", (_name, overrides, reason) => {
    const [report] = buildProviderUsageReport({
      providers: overrides === undefined ? [] : [snapshot("antigravity", overrides)],
      requested: ["antigravity"],
      nowMs: NOW,
    });

    expect(report).toMatchObject({ provider: "antigravity", status: "unavailable" });
    expect(report?.unavailableReason).toBe(reason);
    expect(report?.windows).toEqual([]);
    for (const secret of SECRETS) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("honors a caller's maxAgeSec and drops only the windows whose reset passed", () => {
    const [report] = buildProviderUsageReport({
      providers: [
        snapshot("claudeAgent", {
          usageLimits: limits({
            checkedAt: "2026-11-24T10:00:00.000Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 80,
                resetsAt: "2026-11-24T11:00:00.000Z",
              },
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 20,
                resetsAt: "2026-11-30T00:00:00.000Z",
              },
            ],
          }),
        }),
      ],
      requested: ["claudeAgent"],
      nowMs: NOW,
      maxAgeSec: 3 * 3_600,
    });

    expect(report?.status).toBe("ok");
    expect(report?.windows.map((window) => [window.id, window.remainingFraction])).toEqual([
      ["claude:seven_day", 0.8],
    ]);
  });

  it("names windows only from a fixed vocabulary, whatever free text the provider sends", () => {
    const leak = "leak.person@example.com Bearer sk-leak-token";
    const claude = claudeUsageResponseToLimits({
      checkedAt: "2026-11-24T11:50:00.000Z",
      response: {
        rate_limits_available: true,
        rate_limits: {
          ...({
            model_scoped: [
              { display_name: "Fable", utilization: 10, resets_at: "2026-11-30T00:00:00Z" },
              { display_name: leak, utilization: 20, resets_at: "2026-11-30T00:00:00Z" },
              { display_name: `Opus ${leak}`, utilization: 30, resets_at: null },
            ],
          } as object),
        },
      },
    }).limits;
    const antigravityWindows = [
      ...summaryWindows(
        {
          groups: [
            {
              displayName: leak,
              buckets: [
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  displayName: leak,
                  description: leak,
                  remainingFraction: 0.5,
                  resetTime: "2026-11-24T14:00:00Z",
                },
                {
                  bucketId: `gemini-argon-${leak}`,
                  window: "weekly",
                  displayName: leak,
                  remainingFraction: 0.4,
                  resetTime: "2026-11-30T00:00:00Z",
                },
                { bucketId: leak, displayName: leak, remainingFraction: 0.3 },
              ],
            },
          ],
        },
        NOW,
      ),
      ...modelWindows({
        models: { [`gemini-${leak}`]: { quotaInfo: { remainingFraction: 0.2 } } },
      }),
    ];
    const report = buildProviderUsageReport({
      providers: [
        snapshot("claudeAgent", { usageLimits: claude }),
        snapshot("antigravity", {
          usageLimits: limits({ windows: antigravityWindows }),
        }),
      ],
      requested: ["claudeAgent", "antigravity"],
      nowMs: NOW,
    });

    expect(report.map((entry) => entry.windows.map(({ id, label }) => [id, label]))).toEqual([
      [
        ["claude:seven_day_model:fable", "Weekly · Fable"],
        ["claude:model_scoped:1", "Weekly · Other model"],
        ["claude:model_scoped:2", "Weekly · Other model"],
      ],
      [
        ["antigravity:gemini_5h", "Gemini · 5-hour"],
        ["antigravity:weekly:1", "Weekly"],
        ["antigravity:other:1", "Quota"],
        ["antigravity:gemini_quota", "Gemini · Reported quota"],
      ],
    ]);
    const serialized = JSON.stringify(report);
    for (const fragment of ["@", "example.com", "leak", "sk-", "Bearer"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("marks windows whose pace cannot be computed instead of dropping them", () => {
    const epochSec = (iso: string) => Date.parse(iso) / 1_000;
    const codex = codexRateLimitsToLimits({
      checkedAt: "2026-11-24T11:50:00.000Z",
      snapshot: {
        primary: {
          usedPercent: 40,
          resetsAt: epochSec("2026-11-24T14:00:00Z"),
          windowDurationMins: 300,
        },
        individualLimit: { remainingPercent: 70, resetsAt: epochSec("2026-12-01T00:00:00Z") },
      },
    });
    const claude = claudeUsageResponseToLimits({
      checkedAt: "2026-11-24T11:50:00.000Z",
      response: {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 25, resets_at: "2026-11-24T14:00:00Z" },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 10_000,
            used_credits: 2_500,
            utilization: null,
          },
        },
      },
    }).limits;
    const untouchedReset = "2026-11-24T17:00:00.000Z";
    const antigravity = limits({
      windows: [
        ...summaryWindows(
          {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: untouchedReset,
              },
            ],
          },
          NOW,
        ),
        ...modelWindows({
          models: {
            "gemini-pro": {
              quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-25T00:00:00Z" },
            },
          },
        }),
      ],
    });
    const report = buildProviderUsageReport({
      providers: [
        snapshot("codex", { usageLimits: codex }),
        snapshot("claudeAgent", { usageLimits: claude }),
        snapshot("antigravity", { usageLimits: antigravity }),
      ],
      nowMs: NOW,
    });

    expect(
      report.flatMap((entry) =>
        entry.windows.map(({ id, windowDurationSec, windowDurationSource, pace }) => [
          id,
          windowDurationSec,
          windowDurationSource,
          pace,
        ]),
      ),
    ).toEqual([
      ["codex:primary", 18_000, "provider", { computable: true }],
      [
        "codex:individual",
        undefined,
        undefined,
        { computable: false, reason: "missingWindowDuration" },
      ],
      ["claude:five_hour", 18_000, "known_constant", { computable: true }],
      [
        "claude:monthly_spend",
        undefined,
        undefined,
        { computable: false, reason: "missingResetsAt" },
      ],
      [
        "antigravity:shared_3p_5h",
        18_000,
        "known_constant",
        { computable: false, reason: "notStarted" },
      ],
      [
        "antigravity:gemini_quota",
        undefined,
        undefined,
        { computable: false, reason: "missingWindowDuration" },
      ],
    ]);
  });

  it("fills a known fixed window length the snapshot lacks", () => {
    const [report] = buildProviderUsageReport({
      providers: [
        snapshot("antigravity", {
          usageLimits: limits({
            windows: [
              {
                id: "gemini-weekly",
                kind: "weekly",
                label: "Gemini · Weekly",
                usedPercent: 10,
                resetsAt: "2026-11-30T00:00:00.000Z",
              },
            ],
          }),
        }),
      ],
      requested: ["antigravity"],
      nowMs: NOW,
    });

    expect(report?.windows[0]).toMatchObject({
      id: "antigravity:gemini_weekly",
      windowDurationSec: 604_800,
      windowDurationSource: "known_constant",
      pace: { computable: true },
    });
  });
  it("numbers instances by configured order and never echoes label-derived instance ids", () => {
    const label = "person@example.com";
    const derived = ProviderInstanceId.make(deriveInstanceId("codex", label));
    expect(derived).toBe("codex_person_example_com");
    const derivedClaude = ProviderInstanceId.make(deriveInstanceId("claudeAgent", label));
    const providers = [
      snapshot("codex", { instanceId: derived, displayName: label, usageLimits: limits() }),
      snapshot("codex", { usageLimits: limits() }),
      snapshot("codex", {
        instanceId: ProviderInstanceId.make(deriveInstanceId("codex", "work person")),
        displayName: "work person",
        enabled: false,
      }),
      snapshot("claudeAgent", { instanceId: derivedClaude, displayName: label, enabled: false }),
    ];
    const reportFor = (input: ReadonlyArray<ServerProvider>) =>
      buildProviderUsageReport({ providers: input, nowMs: NOW });

    const report = reportFor(providers);
    expect(
      report.map(({ provider, instance, status, unavailableReason }) => [
        provider,
        instance,
        status,
        unavailableReason,
      ]),
    ).toEqual([
      ["codex", "codex:1", "ok", undefined],
      ["codex", "codex:2", "ok", undefined],
      ["codex", "codex:3", "unavailable", "disabled"],
      ["claudeAgent", "claudeAgent:1", "unavailable", "disabled"],
      ["antigravity", undefined, "unavailable", "notConfigured"],
    ]);
    // Same configuration in any order, or narrowed to one provider, keeps every number.
    expect(reportFor(providers.toReversed())).toEqual(report);
    expect(
      buildProviderUsageReport({
        providers: providers.toReversed(),
        requested: ["codex"],
        nowMs: NOW,
      }),
    ).toEqual(report.slice(0, 3));
    const serialized = JSON.stringify(report);
    for (const fragment of ["person", "example", "work", "@", derived, derivedClaude]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(serialized).not.toMatch(/instanceId/);
  });
});
