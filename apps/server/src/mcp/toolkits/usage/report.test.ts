import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

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
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 37.5,
      resetsAt: "2026-11-24T14:00:00.000Z",
      windowDurationMins: 300,
    },
    { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 },
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
        instanceId: "codex",
        status: "ok",
        observedAt: "2026-11-24T11:50:00.000Z",
        windows: [
          {
            id: "session",
            label: "Session",
            kind: "session",
            remainingFraction: 0.625,
            resetsAt: "2026-11-24T14:00:00.000Z",
            windowDurationSec: 18_000,
          },
          { id: "weekly", label: "Weekly", kind: "weekly", remainingFraction: 0 },
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

    expect(
      report.map(({ provider, instanceId, status }) => [provider, instanceId, status]),
    ).toEqual([
      ["codex", "codex", "ok"],
      ["codex", "codex-work", "unavailable"],
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
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 80,
                resetsAt: "2026-11-24T11:00:00.000Z",
              },
              {
                id: "weekly",
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
      ["weekly", 0.8],
    ]);
  });
});
