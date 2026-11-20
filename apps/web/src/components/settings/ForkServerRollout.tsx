import type { EnvironmentId, ForkRolloutTarget } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { forkRollout } from "~/state/forkRollout";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

const forkVersion = /^[0-9]+\.[0-9]+\.[0-9]+-fork\.[0-9]+\+g[0-9a-f]{10,40}$/;

const targetLabel: Record<ForkRolloutTarget["status"], string> = {
  pending: "Waiting",
  updating: "Updating after active work finishes…",
  done: "Updated",
  failed: "Failed",
};

/** Starts a rollout that this server drives across itself and its linked environments. */
export function ForkServerRollout() {
  const primaryId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primary = environments.find(({ environmentId }) => environmentId === primaryId);
  const supported =
    primaryId !== null &&
    primary?.connection.phase === "connected" &&
    primary.serverConfig?.environment.capabilities.serverSelfUpdateIdleWait === true;
  const linked = useLinkedEnvironments(supported ? primaryId : null);
  const rollout = useEnvironmentQuery(
    supported ? forkRollout.changes({ environmentId: primaryId, input: {} }) : null,
  ).data;
  const start = useAtomCommand(forkRollout.start);
  const cancel = useAtomCommand(forkRollout.cancel);
  const [version, setVersion] = useState("");
  const [order, setOrder] = useState<ReadonlyArray<EnvironmentId>>([]);
  if (!supported || primary === undefined) return null;

  const running = rollout?.status === "running";
  const candidates: ReadonlyArray<readonly [EnvironmentId, string]> = [
    [primaryId, primary.label],
    ...linked.entries(),
  ];
  const ready = forkVersion.test(version.trim()) && order.length > 0 && !running;
  const [first, ...rest] = order;

  return (
    <SettingsRow
      title="Fork server rollout"
      description="This server updates the selected servers in order. Each one restarts only after its active turns and terminals finish. The rollout keeps going after you close this page."
      control={
        <div className="flex w-80 max-w-full flex-col gap-2">
          {running ? null : (
            <>
              <Input
                aria-label="Fork release version"
                placeholder="Fork release version"
                value={version}
                onChange={(event) => setVersion(event.currentTarget.value)}
              />
              {candidates.map(([id, label]) => {
                const position = order.indexOf(id);
                return (
                  <Button
                    key={id}
                    size="sm"
                    variant="outline"
                    aria-pressed={position >= 0}
                    onClick={() =>
                      setOrder((ids) =>
                        ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                      )
                    }
                  >
                    {position >= 0 ? `${position + 1}. ` : ""}
                    {label}
                  </Button>
                );
              })}
              <Button
                size="sm"
                disabled={!ready || first === undefined}
                onClick={() => {
                  if (first === undefined) return;
                  void start({
                    environmentId: primaryId,
                    input: { version: version.trim(), environmentIds: [first, ...rest] },
                  });
                }}
              >
                Deploy to selected servers
              </Button>
            </>
          )}
          {rollout ? (
            <div className="flex flex-col gap-1" aria-live="polite">
              <span className="text-xs">
                {rollout.version} · {rollout.status}
              </span>
              {rollout.targets.map((target) => (
                <span className="text-muted-foreground text-xs" key={target.environmentId}>
                  {target.label}: {targetLabel[target.status]}
                  {target.detail ? `: ${target.detail}` : ""}
                </span>
              ))}
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void cancel({ environmentId: primaryId, input: {} })}
                >
                  Stop rollout
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}
