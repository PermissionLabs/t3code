import {
  type EnvironmentId,
  ForkRollout,
  ForkRolloutError,
  type ForkRolloutStartInput,
  type ForkRolloutTarget,
  OrchestratorMcpFailure,
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
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
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
/** Start requests per step before giving up on a server that never picks the update up. */
const MAX_START_ATTEMPTS = 3;
/** A peer call that takes longer counts as unreachable for that poll. */
const PEER_CALL_TIMEOUT = "30 seconds";

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
  step: { readonly ignoreUpdateId?: string | undefined; readonly started: boolean },
): StepResult | undefined {
  if (status.serverVersion === version) return { ok: true };
  const last = status.lastUpdate;
  if (
    last !== undefined &&
    last.id !== step.ignoreUpdateId &&
    last.targetVersion === version &&
    last.status !== "committed"
  ) {
    return {
      ok: false,
      detail: `Restarted on t3@${status.serverVersion} after the update ${last.status}${last.reason ? ` (${last.reason})` : ""}.`,
    };
  }
  // Before this step asks, a failed job is an earlier attempt's.
  if (step.started && status.job.status === "failed" && status.job.targetVersion === version) {
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
    readonly cancel: Effect.Effect<ForkRollout | null, ForkRolloutError>;
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
  const commands = yield* Semaphore.make(1);
  const selfId = (yield* environment.getDescriptor).environmentId;

  // Written to a temporary file and renamed, so a crash never leaves a partial state file.
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
    const temporary = `${statePath}.tmp`;
    yield* fs.writeFileString(temporary, encodeRollout(next));
    yield* fs.rename(temporary, statePath);
    yield* SubscriptionRef.set(state, next);
  });

  const setTarget = (index: number, target: Partial<ForkRolloutTarget>) =>
    save((rollout) => ({
      targets: rollout.targets.map((entry, position) =>
        position === index ? { ...entry, ...target } : entry,
      ),
    }));

  // The launcher's outcome for this process arrives with the ready event, after a trial commits.
  const awaitReady = lifecycle.snapshot.pipe(
    Effect.map(({ events }) => events.some((event) => event.type === "ready")),
    Effect.repeat(Schedule.spaced("1 second").pipe(Schedule.while(({ input }) => !input))),
    Effect.asVoid,
  );

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

  /** None when the peer did not answer in time or answered with a transient failure. */
  const callPeer = (
    environmentId: EnvironmentId,
    action: "start" | "status" | "cancel",
    version: string,
  ) =>
    peers
      .call({
        environmentId,
        tool: "t3_server_update",
        arguments: { action, version },
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: PeerUpdateStatus,
      })
      .pipe(
        Effect.timeoutOption(PEER_CALL_TIMEOUT),
        // A refusal is final; anything else is a target that is restarting or briefly away.
        Effect.catchIf(
          (failure) => failure.code !== "capability_denied" && failure.code !== "invalid_request",
          () => Effect.succeedNone,
        ),
      );

  /** Whether a peer received it shows in its next status, so the reply itself is not needed. */
  const requestStart = (environmentId: EnvironmentId, version: string) =>
    environmentId === selfId
      ? selfUpdate.startJob(version).pipe(
          Effect.as(true),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.reason }),
          ),
        )
      : callPeer(environmentId, "start", version).pipe(Effect.map(Option.isSome));

  const updateTarget = Effect.fn("ForkRolloutService.updateTarget")(function* (
    index: number,
    target: ForkRolloutTarget,
    version: string,
  ) {
    const self = target.environmentId === selfId;
    const read = self
      ? selfStatus.pipe(Effect.asSome)
      : callPeer(target.environmentId, "status", version);
    let ignoreUpdateId = target.ignoreUpdateId;
    let started = target.started === true;
    let attempts = 0;
    let unreachable = 0;
    while (true) {
      const status = yield* read;
      if (Option.isSome(status)) {
        unreachable = 0;
        if (!started) {
          // Saved before the request leaves, so a lost reply or a restart here keeps the baseline.
          ignoreUpdateId = status.value.lastUpdate?.id;
          const before = evaluateUpdateStep(version, status.value, { ignoreUpdateId, started });
          if (before !== undefined) return before;
          started = true;
          yield* setTarget(index, {
            started,
            ...(ignoreUpdateId === undefined ? {} : { ignoreUpdateId }),
          });
          attempts += 1;
          yield* requestStart(target.environmentId, version);
        } else {
          const result = evaluateUpdateStep(version, status.value, { ignoreUpdateId, started });
          if (result !== undefined) return result;
          const job = status.value.job;
          const ours =
            (job.status === "running" || job.status === "handed-off") &&
            job.targetVersion === version;
          if (!ours) {
            // The request was lost, or the server restarted without installing it.
            if (attempts >= MAX_START_ATTEMPTS) {
              return { ok: false, detail: "The server did not start the update." } as const;
            }
            attempts += 1;
            yield* requestStart(target.environmentId, version);
          }
        }
      } else {
        // A peer is unreachable while its launcher swaps runtimes.
        unreachable += 1;
        if (unreachable >= MAX_UNREACHABLE_POLLS) {
          return { ok: false, detail: "The server did not come back after restarting." } as const;
        }
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const drive: Effect.Effect<void> = Effect.gen(function* () {
    yield* awaitReady;
    const rollout = yield* SubscriptionRef.get(state);
    if (rollout === null || rollout.status !== "running") return;
    for (const [index, target] of rollout.targets.entries()) {
      if (target.status === "done") continue;
      yield* setTarget(index, { status: "updating" });
      const result = yield* updateTarget(index, target, rollout.version).pipe(
        Effect.catchTags({
          OrchestratorMcpFailure: (error) =>
            Effect.succeed<StepResult>({ ok: false, detail: error.message }),
        }),
      );
      if (!result.ok) {
        yield* setTarget(index, { status: "failed", detail: result.detail });
        yield* save(() => ({ status: "failed" }));
        return;
      }
      yield* setTarget(index, { status: "done" });
    }
    yield* save(() => ({ status: "succeeded" }));
  }).pipe(
    // Without a saved state the rollout must not touch another server.
    Effect.catch((cause) =>
      Effect.logError("Could not save the fork rollout; it stopped.", { cause }).pipe(
        Effect.andThen(
          SubscriptionRef.update(state, (rollout): ForkRollout | null =>
            rollout === null ? null : { ...rollout, status: "failed" },
          ),
        ),
      ),
    ),
  );

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
    yield* save(() => ({})).pipe(
      Effect.catch(() =>
        SubscriptionRef.set(state, current).pipe(
          Effect.andThen(Effect.fail(fail("Could not save the rollout under the T3 home."))),
        ),
      ),
    );
    yield* launch;
    return (yield* SubscriptionRef.get(state))!;
  }, commands.withPermits(1));

  const cancel = Effect.fn("ForkRolloutService.cancel")(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current?.status !== "running") return current;
    const fiber = yield* Ref.get(driver);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    const index = current.targets.findIndex((target) => target.status === "updating");
    const updating = current.targets[index];
    let detail: string | undefined;
    if (updating !== undefined) {
      const after =
        updating.environmentId === selfId
          ? yield* selfUpdate
              .cancelJob(current.version)
              .pipe(Effect.andThen(selfStatus.pipe(Effect.asSome)))
          : yield* callPeer(updating.environmentId, "cancel", current.version).pipe(
              Effect.orElseSucceed(() => Option.none()),
            );
      const job = Option.getOrUndefined(after)?.job;
      if (after._tag === "None") {
        detail = "Could not reach this server to stop its update. It may still restart once idle.";
      } else if (
        job !== undefined &&
        (job.status === "running" || job.status === "handed-off") &&
        job.targetVersion === current.version
      ) {
        // Past the final idle check, the launcher owns the restart.
        detail = "This server was already restarting into the update.";
      }
    }
    const cancelled = (rollout: ForkRollout): Partial<ForkRollout> => ({
      status: "cancelled",
      targets: rollout.targets.map((target, position) =>
        position === index
          ? { ...target, status: "pending" as const, ...(detail === undefined ? {} : { detail }) }
          : target,
      ),
    });
    const saved = yield* save(cancelled).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Could not save the cancelled rollout.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!saved) {
      yield* SubscriptionRef.update(state, (rollout) =>
        rollout === null ? null : { ...rollout, ...cancelled(rollout) },
      );
      return yield* new ForkRolloutError({
        reason: "Stopped the rollout, but could not save that. It resumes if this server restarts.",
      });
    }
    return yield* SubscriptionRef.get(state);
  }, commands.withPermits(1));

  if (stored?.status === "running") yield* launch;

  return ForkRolloutService.of({
    start,
    cancel: cancel(),
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(ForkRolloutService, make());
