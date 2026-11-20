import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ServerUpdateJob,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import {
  CLI_RELEASE_BASE_URL_ENV,
  cliReleaseChannelOf,
  crossesReleaseTrack,
} from "@t3tools/shared/cliRelease";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import { databaseMigrationHead } from "../persistence/databaseMigrationHead.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror, managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  isUnpublishedRelease,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  pinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import * as UpdateGate from "./updateGate.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// A staged runtime's cold start can take over a minute on a loaded, swapping host.
const PREFLIGHT_TIMEOUT = Duration.minutes(3);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
    /** The fork rollout's update: waits for idle and keeps going without the requesting client. */
    readonly startJob: (targetVersion: string) => Effect.Effect<void, ServerSelfUpdateError>;
    readonly cancelJob: (targetVersion: string) => Effect.Effect<void>;
    readonly job: Effect.Effect<ServerUpdateJob>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

/**
 * A server starting from the runtime its launcher settled on means runtimes left by earlier
 * updates can go. The boot service says so through its IPC context. The SSH launcher and the
 * install script's `t3` start this home's pinned runtime directly, without one.
 */
export const pruneRuntimesOnStart = Effect.fn("cloud.server_self_update.prune_on_start")(
  function* (input: { readonly baseDir: string; readonly managed: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const executablePath = yield* HostProcess.ExecutablePath;
    const { entryPath } = pinnedRuntimePaths(path, input.baseDir, packageJson.version, platform);
    // The executable path is resolved, so it names the real path of a symlinked T3 home.
    const realEntryPath = yield* fs.realPath(entryPath).pipe(Effect.orElseSucceed(() => entryPath));
    if (!input.managed && executablePath !== entryPath && executablePath !== realEntryPath) {
      return [];
    }
    const removed = yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [packageJson.version],
    });
    if (removed.length > 0) {
      yield* Effect.logInfo("Removed unused t3 runtimes.", { versions: removed });
    }
    return removed;
  },
);

/** The client checks this when planning; the host checks again because its database may have
 * moved on since (another client updated it). Stable and Nightly each build their own commits,
 * so crossing tracks needs the target release to know every migration this database holds. */
export function trackSwitchBlockReason(input: {
  readonly serverVersion: string;
  readonly targetVersion: string;
  readonly targetDatabaseMigration: number | undefined;
  /** Read only for a crossing; undefined when the database cannot be read. */
  readonly databaseMigration: () => number | undefined;
}): string | null {
  if (!crossesReleaseTrack(input.serverVersion, input.targetVersion)) return null;
  const databaseMigration = input.databaseMigration();
  if (input.targetDatabaseMigration === undefined || databaseMigration === undefined) {
    return `Cannot confirm this database works with t3@${input.targetVersion}. Switch tracks from Settings → About → Update track, which checks it first.`;
  }
  return input.targetDatabaseMigration < databaseMigration
    ? `This database has changes t3@${input.targetVersion} does not support yet; it stays on this release.`
    : null;
}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* Terminal.TerminalManager;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const httpClient = yield* HttpClient.HttpClient;
  const mirror = managedUpdateMirror(policy.document);
  const releaseBaseUrl =
    mirror?.feedUrl ??
    Option.getOrUndefined(yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option));
  const inFlight = yield* Ref.make(false);
  const updateGate = yield* UpdateGate.UpdateGate;

  yield* pruneRuntimesOnStart({ baseDir: serverConfig.baseDir, managed: launcher.managed }).pipe(
    Effect.forkScoped,
  );

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const crossesTrackUnsafely = (input: ServerSelfUpdateInput) =>
    trackSwitchBlockReason({
      serverVersion: packageJson.version,
      targetVersion: input.targetVersion,
      targetDatabaseMigration: input.targetDatabaseMigration,
      databaseMigration: () => databaseMigrationHead(serverConfig.dbPath),
    });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void, onHandoffAccepted = () => Effect.void) {
    const policyRefusal = managedUpdateRefusal(
      policy.document,
      capability === "boot-service" ? cliReleaseChannelOf(input.targetVersion.trim()) : undefined,
    );
    if (policyRefusal !== undefined) {
      return yield* failWith(policyRefusal);
    }
    if (input.waitForIdle && capability !== "boot-service") {
      return yield* failWith("A fork rollout requires a background service.");
    }
    if (capability === "desktop-managed") {
      const unsafeCrossing = input.channel === undefined ? null : crossesTrackUnsafely(input);
      if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(
          reportProgress,
          input.channel === undefined
            ? undefined
            : { channel: input.channel, targetVersion: input.targetVersion },
        );
      }
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const unsafeCrossing = crossesTrackUnsafely(input);
    if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);
    const targetVersion = input.targetVersion.trim();
    if (input.waitForIdle && !releaseBaseUrl?.startsWith("https://")) {
      return yield* failWith(
        "Configure an HTTPS release mirror on this server before starting a fork rollout.",
      );
    }
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    let accepted = false;
    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        httpClient,
        platform,
        arch,
        releaseBaseUrl,
        requirePublishedRelease: mirror !== undefined || input.waitForIdle === true,
        validate: (runtime) =>
          runner
            .run({
              command: pinnedRuntimeCommand(runtime).command,
              args: [
                ...pinnedRuntimeCommand(runtime).args,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : mirror !== undefined && isUnpublishedRelease(error)
              ? failWith(
                  `${mirror.organization}'s update mirror has no t3@${targetVersion} for this machine.`,
                  error,
                )
              : failWith(`Could not prepare t3@${targetVersion}.`, error),
        ),
      );

      if (input.waitForIdle) {
        const isBusy = Effect.suspend(() => projections.hasPendingUpdateWork()).pipe(
          Effect.flatMap((busy) =>
            busy ? Effect.succeed(true) : terminals.hasUpdateBlockingSessions,
          ),
          Effect.mapError((cause) =>
            failWith("Could not check whether the server is idle.", cause),
          ),
        );
        const waitUntilIdle = isBusy.pipe(
          Effect.repeat(
            Schedule.spaced("2 seconds").pipe(Schedule.while(({ input }) => input === true)),
          ),
        );
        // Closing waits for admitted turn and terminal starts, so the check below sees them.
        const closeWhenIdle: Effect.Effect<void, ServerSelfUpdateError> = Effect.gen(function* () {
          yield* waitUntilIdle;
          yield* updateGate.close;
          if (yield* isBusy) {
            yield* updateGate.reopen;
            yield* closeWhenIdle;
          }
        });
        if (yield* isBusy) yield* reportProgress("waiting-for-idle");
        yield* closeWhenIdle;
      }
      yield* reportProgress("installing");
      const updateId = yield* Effect.uninterruptible(
        launcher.requestUpdate({ targetVersion, dbPath: serverConfig.dbPath }).pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              accepted = true;
            }).pipe(Effect.andThen(onHandoffAccepted())),
          ),
        ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(
      // Once the launcher accepted, it owns the restart; an interrupt after that keeps the gate shut.
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !accepted
          ? Ref.set(inFlight, false).pipe(Effect.andThen(updateGate.reopen))
          : Effect.void,
      ),
    );
  });

  const layerScope = yield* Scope.Scope;
  const job = yield* Ref.make<ServerUpdateJob>({ status: "idle" });
  const jobFiber = yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined);
  const startJob = Effect.fn("cloud.server_self_update.start_job")(function* (
    targetVersion: string,
  ) {
    const current = yield* Ref.get(job);
    if (current.status === "running" || current.status === "handed-off") {
      if (current.targetVersion === targetVersion) return;
      return yield* failWith(`An update to t3@${current.targetVersion} is already in progress.`);
    }
    yield* Ref.set(job, { status: "running", targetVersion, stage: "downloading" });
    const fiber = yield* update(
      { targetVersion, waitForIdle: true },
      (stage) => Ref.set(job, { status: "running", targetVersion, stage }),
      () => Ref.set(job, { status: "handed-off", targetVersion }),
    ).pipe(
      Effect.catchTags({
        ServerSelfUpdateError: (error) =>
          Ref.set(job, { status: "failed", targetVersion, reason: error.reason }),
      }),
      Effect.onInterrupt(() =>
        Ref.update(job, (current): ServerUpdateJob =>
          current.status === "running"
            ? { status: "failed", targetVersion, reason: "The update was cancelled." }
            : current,
        ),
      ),
      Effect.forkIn(layerScope),
    );
    yield* Ref.set(jobFiber, fiber);
  });
  const cancelJob = Effect.fn("cloud.server_self_update.cancel_job")(function* (
    targetVersion: string,
  ) {
    const current = yield* Ref.get(job);
    const fiber = yield* Ref.get(jobFiber);
    // After the launcher accepts, the restart belongs to it.
    if (
      current.status !== "running" ||
      current.targetVersion !== targetVersion ||
      current.stage === "installing" ||
      fiber === undefined
    ) {
      return;
    }
    yield* Fiber.interrupt(fiber);
  });

  return ServerSelfUpdate.of({
    startJob,
    cancelJob,
    job: Ref.get(job),
    update,
    commitDesktopUpdate: Effect.fn("ServerSelfUpdate.commitDesktopUpdate")(
      function (requestId, onHandoffAccepted) {
        return desktopAppUpdate.commit(requestId, onHandoffAccepted);
      },
    ),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);

// A rollout may wait indefinitely, so the client owns it until launcher handoff.
export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    const run = selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }))
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
      );
    return input.waitForIdle ? Effect.forkScoped(run) : Effect.forkDetach(run);
  });
