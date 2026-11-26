import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
} from "@t3tools/shared/usageLimits";
import { collectLimitNotices, formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
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
import { useSidebarUsageLimitsHeight } from "./useSidebarUsageLimitsHeight";

export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const minute = useNowMinute();
  const now = Date.parse(`${minute}Z`);
  const navigate = useNavigate();
  const gt = useGT();
  const m = useMessages();
  const { isMobile, setOpenMobile } = useSidebar();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const { listRef, maxHeight, minHeight, maxHeightLimit, handleProps } =
    useSidebarUsageLimitsHeight();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const connected = new Map(
    [...presentations].filter(([, entry]) => entry.connection.phase === "connected"),
  );
  const connectedKey = [...connected.keys()].sort().join(",");
  const pools = collectLimitPools(collectLimitAccounts(connected), now);
  const notices = collectLimitNotices(connected, m);
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
      aria-label={gt("Subscription limits")}
      className="relative min-w-0 border-t border-sidebar-border pt-2"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={gt("Resize subscription limits")}
        aria-valuenow={maxHeight}
        aria-valuemin={minHeight}
        aria-valuemax={maxHeightLimit}
        tabIndex={0}
        className="group absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize select-none touch-none focus-visible:outline-none"
        {...handleProps}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-sidebar-foreground/25 group-focus-visible:bg-primary/60 group-active:bg-primary/60 group-data-[dragging=true]:bg-primary/60"
        />
      </div>
      <div className="mb-1 flex items-center justify-between px-2 text-2xs text-muted-foreground">
        <span>
          <T>Limits · all environments</T>
        </span>
        {offlineCount > 0 ? (
          <span>
            <T>
              <Var>{offlineCount}</Var> offline
            </T>
          </span>
        ) : null}
      </div>
      <div
        ref={listRef}
        data-slot="sidebar-usage-limits-list"
        className="flex flex-col gap-1 overflow-y-auto"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {pools.map((pool) => {
          const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
          const windows = displayLimitWindows(pool);
          return (
            <Button
              key={pool.driver}
              variant="ghost"
              size="sm-multiline"
              className="w-full"
              aria-label={gt("{provider} subscription limits. Open usage details.", {
                provider: label,
              })}
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
                  const resetsIn = reset ? formatDuration(Math.max(0, reset.at - now), m) : null;
                  return (
                    <span
                      key={`${window.kind}:${window.id}`}
                      className="flex min-w-0 items-baseline gap-2 text-2xs tabular-nums"
                    >
                      <span className="truncate text-muted-foreground">{window.label}</span>
                      <span className="ms-auto shrink-0">
                        {gt("{percent}% left", { percent: window.remainingPercent })}
                      </span>
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
              ? gt("Some limits unavailable · Details")
              : connected.size === 0
                ? gt("Connect to see limits")
                : gt("No limits reported · Details")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
