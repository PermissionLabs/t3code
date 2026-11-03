import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  displayLimitWindows,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useEffect, useEffectEvent, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const minute = useNowMinute();
  const now = Date.parse(`${minute}Z`);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const connected = new Map(
    [...presentations].filter(([, entry]) => entry.connection.phase === "connected"),
  );
  const connectedKey = [...connected.keys()].sort().join(",");
  const pools = collectLimitPools(collectLimitAccounts(connected), now);
  const notices = collectLimitNotices(connected);
  const offlineCount = presentations.size - connected.size;

  const refresh = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    void Promise.allSettled(
      [...connected].map(([environmentId, entry]) => {
        if (!entry.serverConfig || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) {
          return;
        }
        return refreshUsageLimits(
          environmentId,
          () => refreshProviders({ environmentId, input: {} }),
          true,
        );
      }),
    ).then((results) => {
      if (results.some((result) => result.status === "rejected" || result.value !== undefined)) {
        setRefreshFailed(
          results.some(
            (result) =>
              result.status === "rejected" ||
              (result.value !== undefined && AsyncResult.isFailure(result.value)),
          ),
        );
      }
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes external quota snapshots through the existing five-minute throttle while the client is visible
  useEffect(() => {
    if (connectedKey && minute) refresh();
  }, [connectedKey, minute]);

  const openLimits = () => {
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };

  return (
    <section
      aria-label="Subscription limits"
      className="min-w-0 border-t border-sidebar-border pt-2"
    >
      <div className="mb-1 flex items-center justify-between px-2 text-2xs text-muted-foreground">
        <span>Limits · all environments</span>
        {offlineCount > 0 ? <span>{offlineCount} offline</span> : null}
      </div>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {pools.map((pool) => {
          const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
          const windows = displayLimitWindows(pool);
          return (
            <Button
              key={pool.driver}
              variant="ghost"
              size="sm-multiline"
              className="w-full"
              aria-label={`${label} subscription limits. Open usage details.`}
              onClick={openLimits}
            >
              <span className="flex w-full min-w-0 flex-col gap-1 py-1">
                <span className="flex items-center gap-1.5 text-xs">
                  <ProviderInstanceIcon
                    driverKind={pool.driver}
                    displayName={label}
                    indicatorBackground="var(--sidebar)"
                    className="size-3.5"
                    iconClassName="size-3.5"
                  />
                  <span>{label}</span>
                </span>
                {windows.map((window) => {
                  const reset = window.resets.find((entry) => entry.restoresPercent > 0);
                  const resetsIn = reset ? formatDuration(Math.max(0, reset.at - now)) : null;
                  return (
                    <span
                      key={`${window.kind}:${window.id}`}
                      className="flex min-w-0 items-baseline gap-2 text-2xs tabular-nums"
                    >
                      <span className="truncate text-muted-foreground">{window.label}</span>
                      <span className="ms-auto shrink-0">{window.remainingPercent}% left</span>
                      {resetsIn ? (
                        <span className="shrink-0 text-muted-foreground">↻ {resetsIn}</span>
                      ) : null}
                    </span>
                  );
                })}
              </span>
            </Button>
          );
        })}
        {pools.length === 0 || notices.length > 0 || refreshFailed ? (
          <Button variant="ghost-muted" size="xs" className="w-full" onClick={openLimits}>
            {notices.length > 0 || refreshFailed
              ? "Some limits unavailable · Details"
              : connected.size === 0
                ? "Connect to see limits"
                : "No limits reported · Details"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
