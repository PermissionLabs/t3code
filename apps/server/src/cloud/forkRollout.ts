import {
  type EnvironmentId,
  ForkRollout,
  ForkRolloutError,
  type ForkRolloutStartInput,
  type ForkRolloutTarget,
  ServerSelfUpdateOutcome,
  ServerUpdateJob,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import { isExactServiceVersion } from "./serviceProtocol.ts";

/** How often a running rollout reads its current target. */
export const POLL_INTERVAL = "5 seconds";
/** A peer that stays unreachable this many polls in a row fails its step. */
const MAX_UNREACHABLE_POLLS = 180;

const STATE_FILE = "fork-rollout.json";
const decodeRollout = Schema.decodeUnknownOption(Schema.fromJsonString(ForkRollout));
const encodeRollout = Schema.encodeSync(Schema.fromJsonString(ForkRollout));

const PeerUpdateStatus = Schema.Struct({
  serverVersion: Schema.String,
  job: ServerUpdateJob,
  lastUpdate: Schema.optionalKey(ServerSelfUpdateOutcome),
});
type PeerUpdateStatus = typeof PeerUpdateStatus.Type;

type StepResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** Whether a target finished the step: done, failed, or still in progress (undefined). */
export function evaluateUpdateStep(
  version: string,
  status: PeerUpdateStatus,
): StepResult | undefined {
  if (status.serverVersion === version) return { ok: true };
  const last = status.lastUpdate;
  if (last !== undefined && last.targetVersion === version && last.status !== "committed") {
    return {
      ok: false,
      detail: `Restarted on t3@${status.serverVersion} after the update ${last.status}${last.reason ? ` (${last.reason})` : ""}.`,
    };
  }
  if (status.job.status === "failed" && status.job.targetVersion === version) {
    return { ok: false, detail: status.job.reason };
  }
  return undefined;
}

/**
 * Drives one rollout across this server and linked environments in order. The state lives in a
 * file under the T3 home, so the rollout survives this server's own restart and keeps going after
 * the client that started it disconnects.
 */
export class ForkRolloutService extends Context.Service<
  ForkRolloutService,
  {
    readonly start: (input: ForkRolloutStartInput) => Effect.Effect<ForkRollout, ForkRolloutError>;
    readonly cancel: Effect.Effect<ForkRollout | null>;
    readonly changes: Stream.Stream<ForkRollout | null>;
  }
>()("t3/cloud/forkRollout/ForkRolloutService") {}

export const make = Effect.fn("ForkRolloutService.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const statePath = path.join(config.baseDir, STATE_FILE);

  const stored = yield* fs.readFileString(statePath).pipe(
    Effect.map((raw) => Option.getOrNull(decodeRollout(raw))),
    Effect.orElseSucceed(() => null),
  );
  const state = yield* SubscriptionRef.make<ForkRollout | null>(stored);
  const driver = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const selfId = (yield* environment.getDescriptor).environmentId;

  const save = Effect.fn("ForkRolloutService.save")(function* (
    change: (rollout: ForkRollout) => Partial<ForkRollout>,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current === null) return;
    const next: ForkRollout = {
      ...current,
      ...change(current),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* fs
      .writeFileString(statePath, encodeRollout(next))
      .pipe(
        Effect.catch((cause) => Effect.logWarning("Could not save the fork rollout.", { cause })),
      );
    yield* SubscriptionRef.set(state, next);
  });

  const setTarget = (index: number, target: Partial<ForkRolloutTarget>) =>
    save((rollout) => ({
      targets: rollout.targets.map((entry, position) =>
        position === index ? { ...entry, ...target } : entry,
      ),
    }));

  const selfStatus = Effect.gen(function* () {
    const lastUpdate = yield* ServerLifecycleEvents.latestUpdateOutcome.pipe(
      Effect.provideService(ServerLifecycleEvents.ServerLifecycleEvents, lifecycle),
    );
    return {
      serverVersion: packageJson.version,
      job: yield* selfUpdate.job,
      ...(lastUpdate === undefined ? {} : { lastUpdate }),
    } satisfies PeerUpdateStatus;
  });

  const callPeer = (environmentId: EnvironmentId, action: "start" | "status", version: string) =>
    peers.call({
      environmentId,
      tool: "t3_server_update",
      arguments: { action, version },
      limits: { runtimeMode: "full-access", interactionMode: "default" },
      success: PeerUpdateStatus,
    });

  const updateTarget = Effect.fn("ForkRolloutService.updateTarget")(function* (
    environmentId: EnvironmentId,
    version: string,
  ) {
    const self = environmentId === selfId;
    const read = self
      ? selfStatus.pipe(Effect.asSome)
      : callPeer(environmentId, "status", version).pipe(Effect.option);
    const first = self ? yield* selfStatus : yield* callPeer(environmentId, "status", version);
    const settled = evaluateUpdateStep(version, first);
    if (settled !== undefined) return settled;
    const started = self
      ? yield* selfUpdate.startJob(version).pipe(
          Effect.as(undefined),
          Effect.catchTags({
            ServerSelfUpdateError: (error) =>
              Effect.succeed<StepResult>({ ok: false, detail: error.reason }),
          }),
        )
      : yield* callPeer(environmentId, "start", version).pipe(Effect.as(undefined));
    if (started !== undefined) return started;
    let unreachable = 0;
    while (true) {
      yield* Effect.sleep(POLL_INTERVAL);
      const status = yield* read;
      if (Option.isNone(status)) {
        // A peer is unreachable while its launcher swaps runtimes.
        unreachable += 1;
        if (unreachable >= MAX_UNREACHABLE_POLLS) {
          return { ok: false, detail: "The server did not come back after restarting." } as const;
        }
        continue;
      }
      unreachable = 0;
      const result = evaluateUpdateStep(version, status.value);
      if (result !== undefined) return result;
      if (status.value.job.status === "idle") {
        return {
          ok: false,
          detail: "The server restarted without installing the update.",
        } as const;
      }
    }
  });

  const drive: Effect.Effect<void> = Effect.gen(function* () {
    const rollout = yield* SubscriptionRef.get(state);
    if (rollout === null || rollout.status !== "running") return;
    for (const [index, target] of rollout.targets.entries()) {
      if (target.status === "done") continue;
      yield* setTarget(index, { status: "updating" });
      const result = yield* updateTarget(target.environmentId, rollout.version).pipe(
        Effect.catch((error) => Effect.succeed({ ok: false, detail: error.message } as const)),
      );
      if (!result.ok) {
        yield* setTarget(index, { status: "failed", detail: result.detail });
        yield* save(() => ({ status: "failed" }));
        return;
      }
      yield* setTarget(index, { status: "done" });
    }
    yield* save(() => ({ status: "succeeded" }));
  });

  const launch = Effect.gen(function* () {
    const fiber = yield* drive.pipe(Effect.forkIn(scope));
    yield* Ref.set(driver, fiber);
  });

  const start = Effect.fn("ForkRolloutService.start")(function* (input: ForkRolloutStartInput) {
    const fail = (reason: string) => new ForkRolloutError({ reason });
    const current = yield* SubscriptionRef.get(state);
    if (current?.status === "running") return yield* fail("A fork rollout is already running.");
    const version = input.version.trim();
    if (!isExactServiceVersion(version))
      return yield* fail(`'${version}' is not an exact version.`);
    if (new Set(input.environmentIds).size !== input.environmentIds.length) {
      return yield* fail("Select each server once.");
    }
    const self = yield* environment.getDescriptor;
    const targets: Array<ForkRolloutTarget> = [];
    for (const environmentId of input.environmentIds) {
      if (environmentId === self.environmentId) {
        targets.push({ environmentId, label: self.label, status: "pending" });
        continue;
      }
      const link = yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(link)) {
        return yield* fail(`${environmentId} is not linked to this server.`);
      }
      targets.push({ environmentId, label: link.value.label || environmentId, status: "pending" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.set(state, {
      id: yield* random.uuidV4().pipe(Effect.orDie),
      version,
      status: "running",
      targets,
      createdAt: now,
      updatedAt: now,
    });
    yield* save(() => ({}));
    yield* launch;
    return (yield* SubscriptionRef.get(state))!;
  });

  const cancel = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current?.status !== "running") return current;
    const fiber = yield* Ref.get(driver);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    const updating = current.targets.find((target) => target.status === "updating");
    if (updating !== undefined) {
      yield* updating.environmentId === selfId
        ? selfUpdate.cancelJob
        : peers
            .call({
              environmentId: updating.environmentId,
              tool: "t3_server_update",
              arguments: { action: "cancel" },
              limits: { runtimeMode: "full-access", interactionMode: "default" },
              success: PeerUpdateStatus,
            })
            .pipe(Effect.ignore);
    }
    yield* save((rollout) => ({
      status: "cancelled",
      targets: rollout.targets.map((target) =>
        target.status === "updating" ? { ...target, status: "pending" } : target,
      ),
    }));
    return yield* SubscriptionRef.get(state);
  });

  if (stored?.status === "running") yield* launch;

  return ForkRolloutService.of({
    start,
    cancel,
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(ForkRolloutService, make());
