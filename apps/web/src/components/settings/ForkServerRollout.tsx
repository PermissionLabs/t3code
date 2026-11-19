import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { useState } from "react";

import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  canUpdateServer,
  serverUpdateStageLabel,
  type ServerUpdateOutcome,
  type ServerUpdateTarget,
  useServerUpdate,
} from "../ServerUpdateAction";
import { SettingsRow } from "./settingsLayout";

const forkVersion = /^[0-9]+\.[0-9]+\.[0-9]+-fork\.[0-9]+\+g[0-9a-f]{10}$/;

export function ForkServerRollout() {
  const { environments } = useEnvironments();
  const updateServer = useServerUpdate();
  const [version, setVersion] = useState("");
  const [order, setOrder] = useState<ReadonlyArray<EnvironmentId>>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Readonly<Record<string, string>>>({});
  const ids = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessions = useAtomValue(environmentSessionStatesAtom(ids));
  const updates = useAtomValue(environmentUpdateStatesAtom(ids));

  const targets = environments.flatMap((environment, index) => {
    const config = environment.serverConfig?.environment;
    if (
      config?.capabilities.serverSelfUpdate !== "boot-service" ||
      config.capabilities.serverSelfUpdateIdleWait !== true ||
      environment.connection.phase !== "connected" ||
      !canUpdateServer(sessions[index]!)
    ) {
      return [];
    }
    return [
      {
        target: {
          environmentId: environment.environmentId,
          serverLabel: environment.label,
          selfUpdate: "boot-service",
          targetVersion: version.trim(),
          waitForIdle: true,
        } satisfies ServerUpdateTarget,
        version: config.serverVersion,
      },
    ];
  });
  if (targets.length === 0 && !running && Object.keys(results).length === 0) return null;
  const selected = order.map((id) => targets.find(({ target }) => target.environmentId === id));
  const validVersion = forkVersion.test(version.trim());
  const ready =
    validVersion &&
    selected.length > 0 &&
    selected.every(
      (entry) =>
        entry !== undefined &&
        (entry.target.targetVersion === entry.version ||
          compareSemverVersions(entry.target.targetVersion, entry.version) > 0),
    );

  const rows = environments.flatMap((environment, index) => {
    const id = environment.environmentId;
    const position = order.indexOf(id);
    const available = targets.some(({ target }) => target.environmentId === id);
    return available || position >= 0 || results[id] !== undefined
      ? [{ id, position, available, environment, state: updates[index] }]
      : [];
  });

  const deploy = async () => {
    if (!ready || running) return;
    setRunning(true);
    setResults({});
    for (const entry of selected) {
      if (entry === undefined) break;
      const { target } = entry;
      const id = target.environmentId;
      if (target.targetVersion === entry.version) {
        setResults((current) => ({ ...current, [id]: "Already on target version" }));
        continue;
      }
      setResults((current) => ({ ...current, [id]: "Preparing update…" }));
      const outcome = await updateServer(target, { quiet: true }).catch(
        (error): ServerUpdateOutcome => ({
          status: "failed",
          message: error instanceof Error ? error.message : "Server update failed",
        }),
      );
      if (outcome.status !== "updated") {
        setResults((current) => ({
          ...current,
          [id]: outcome.status === "failed" ? outcome.message : "Update interrupted",
        }));
        break;
      }
      setResults((current) => ({ ...current, [id]: "Updated and reconnected" }));
    }
    setRunning(false);
  };

  return (
    <SettingsRow
      title="Fork server rollout"
      description="Select connected servers in rollout order. Each server waits for active work to finish before restarting. Keep this page open until the rollout completes."
      control={
        <div className="flex w-80 max-w-full flex-col gap-2">
          <Input
            aria-label="Fork release version"
            placeholder="Fork release version"
            value={version}
            disabled={running}
            onChange={(event) => setVersion(event.currentTarget.value)}
          />
          {rows.map(({ id, position, available, environment, state }) => {
            return (
              <div className="flex flex-col gap-1" key={id}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running || (!available && position < 0)}
                  aria-pressed={position >= 0}
                  onClick={() =>
                    setOrder((ids) =>
                      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                    )
                  }
                >
                  {position >= 0 ? `${position + 1}. ` : ""}
                  {environment.label}
                  {environment.serverConfig
                    ? ` · ${environment.serverConfig.environment.serverVersion}`
                    : ""}
                </Button>
                <span className="text-muted-foreground text-xs" aria-live="polite">
                  {state?.status === "running"
                    ? serverUpdateStageLabel(state.stage)
                    : (results[id] ??
                      (running && position >= 0 ? "Waiting for previous server…" : undefined))}
                </span>
              </div>
            );
          })}
          <Button size="sm" disabled={!ready || running} onClick={() => void deploy()}>
            {running ? "Rollout in progress" : "Deploy to selected servers"}
          </Button>
        </div>
      }
    />
  );
}
