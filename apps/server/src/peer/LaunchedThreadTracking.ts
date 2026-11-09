import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  type ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadHookCommands from "../hooks/ThreadHookCommands.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerForwarding from "./PeerForwarding.ts";

/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** How a follower retries; tests step it by hand. */
const LaunchedRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/LaunchedThreadTracking/LaunchedRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);
/** How long a launched thread there is followed after its launch. */
export const LAUNCHED_FOLLOW_DAYS = 14;
/** How often a launched thread there is checked; tests step it by hand. */
export const LaunchedPollSchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/LaunchedThreadTracking/LaunchedPollSchedule",
  { defaultValue: () => Schedule.spaced(Duration.minutes(1)) },
);

type LifecycleState = "active" | "settled" | "archived" | "deleted";
type LifecycleChange = "settled" | "unsettled" | "archived" | "deleted";
type RunChange = "completed" | "failed" | "cancelled" | "interrupted";

/**
 * What a hook reads on stdin for a `launched_thread.*` event. Ids and states only: no titles,
 * prompts, results or messages. `environmentId` is the linked environment the thread runs in.
 * `sequence` counts this launched thread's events from 1; `eventId` is stable for each of them,
 * so a hook that must not act twice keys on it.
 */
export interface LaunchedThreadHookPayload extends ThreadHookCommands.ThreadHookPayloadBase {
  readonly event: "launched_thread.lifecycle" | "launched_thread.run";
  readonly change: LifecycleChange | RunChange;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly environmentId: string;
  readonly thread: {
    readonly threadId: string;
    readonly role: "launched-remote";
    readonly launcherThreadId: string;
    readonly settled: boolean;
    readonly archived: boolean;
    readonly deleted: boolean;
    /** The latest run's status there; null before it has one, or once the thread is gone. */
    readonly runStatus: string | null;
  };
}

interface Row {
  readonly environment_id: string;
  readonly thread_id: string;
  readonly launcher_thread_id: string;
  readonly launcher_provider_instance_id: string;
  readonly launched_at: string;
  readonly lifecycle_state: LifecycleState;
  readonly run_id: string | null;
  readonly run_status: string | null;
  readonly event_count: number;
  readonly ended_at: string | null;
}

export class LaunchedThreadTracking extends Context.Service<
  LaunchedThreadTracking,
  {
    /**
     * Records a thread `launcher` launched in the linked environment `environmentId` and starts
     * following it. Does nothing while `launchedThreadTracking` is off. Never fails the launch.
     */
    readonly record: (
      launcher: McpInvocationContext.McpThreadCaller,
      environmentId: EnvironmentId,
      launched: unknown,
    ) => Effect.Effect<void>;
    /** One look at a launched thread there; true once there is nothing left to follow. */
    readonly lookOnce: (
      environmentId: string,
      threadId: string,
    ) => Effect.Effect<boolean, OrchestratorMcpFailure | SqlError.SqlError | OrchestratorV2Error>;
    /** Follows every launched thread still followed, including after a restart. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/LaunchedThreadTracking") {}

const LaunchedThread = Schema.Struct({ threadId: ThreadId });
const decodeLaunched = Schema.decodeUnknownOption(LaunchedThread);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** Refusals no retry changes: the link is gone or refused this caller. */
const isFinal = (error: unknown) =>
  isMcpFailure(error) && (error.code === "capability_denied" || error.code === "run_not_found");

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const runChange = (status: string): RunChange =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";

const lifecycleChange = (from: LifecycleState, to: LifecycleState): LifecycleChange | undefined => {
  if (from === to) return undefined;
  switch (to) {
    case "settled":
      return "settled";
    case "active":
      return from === "settled" ? "unsettled" : undefined;
    case "archived":
      return "archived";
    case "deleted":
      return "deleted";
  }
};

const latestRun = (read: OrchestratorMcpThreadReadResult) =>
  read.recentRuns.find((run) => run.runId === read.thread.latestRunId) ??
  read.recentRuns.toSorted((left, right) => right.ordinal - left.ordinal)[0];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const hooks = yield* ThreadHookCommands.ThreadHookCommands;
  const lifecyclePoll = yield* LaunchedPollSchedule;
  const followRetry = yield* LaunchedRetrySchedule;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;
  // Hooks for launched threads run one at a time, as thread hooks do.
  const hookLock = yield* Semaphore.make(1);

  // This fork's own table, made here rather than by a numbered migration: the migrator skips
  // every id up to the highest recorded one and refuses a history whose names differ, so a
  // fork migration would either collide with a later upstream one or hide it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_launched_remote_threads (
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      launcher_thread_id TEXT NOT NULL,
      launcher_provider_instance_id TEXT NOT NULL,
      launched_at TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      run_id TEXT,
      run_status TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      PRIMARY KEY (environment_id, thread_id)
    )
  `;

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.launchedThreadTracking),
    Effect.orElseSucceed(() => false),
  );

  const readRow = (environmentId: string, threadId: string) =>
    sql<Row>`
      SELECT * FROM fork_launched_remote_threads
      WHERE environment_id = ${environmentId} AND thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]));

  const end = Effect.fn("LaunchedThreadTracking.end")(function* (row: Row) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
        UPDATE fork_launched_remote_threads SET ended_at = ${now}
        WHERE environment_id = ${row.environment_id} AND thread_id = ${row.thread_id}
      `;
  });

  /** How this environment reaches the thread there: as the thread that launched it. */
  const scopeFor = (row: Row): McpInvocationContext.McpInvocationScope => ({
    environmentId: hereId,
    requestNamespace: `launched-thread:${row.launcher_thread_id}`,
    thread: {
      threadId: ThreadId.make(row.launcher_thread_id),
      providerSessionId: `launched-thread:${row.thread_id}`,
      providerInstanceId: row.launcher_provider_instance_id as ProviderInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /** Runs the hooks for one change, then saves it, so a restart does not report it again. */
  const emit = Effect.fn("LaunchedThreadTracking.emit")(function* (
    row: Row,
    event: LaunchedThreadHookPayload["event"],
    change: LaunchedThreadHookPayload["change"],
    next: {
      readonly lifecycle: LifecycleState;
      readonly runId: string | null;
      readonly runStatus: string | null;
    },
  ) {
    const sequence = row.event_count + 1;
    const payload: LaunchedThreadHookPayload = {
      version: 1,
      event,
      change,
      eventId: `launched-thread:${row.environment_id}:${row.thread_id}:${sequence}`,
      sequence,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
      environmentId: row.environment_id,
      thread: {
        threadId: row.thread_id,
        role: "launched-remote",
        launcherThreadId: row.launcher_thread_id,
        settled: next.lifecycle === "settled",
        archived: next.lifecycle === "archived",
        deleted: next.lifecycle === "deleted",
        runStatus: next.lifecycle === "deleted" ? null : next.runStatus,
      },
    };
    yield* hooks.run(payload);
    yield* sql`
        UPDATE fork_launched_remote_threads SET
          lifecycle_state = ${next.lifecycle},
          run_id = ${next.runId},
          run_status = ${next.runStatus},
          event_count = ${sequence}
        WHERE environment_id = ${row.environment_id} AND thread_id = ${row.thread_id}
      `;
    return {
      ...row,
      lifecycle_state: next.lifecycle,
      run_id: next.runId,
      run_status: next.runStatus,
      event_count: sequence,
    } satisfies Row;
  });

  const lookOnce: LaunchedThreadTracking["Service"]["lookOnce"] = Effect.fn(
    "LaunchedThreadTracking.lookOnce",
  )(function* (environmentId, threadId) {
    if (!(yield* enabled)) return true;
    const row = yield* readRow(environmentId, threadId);
    if (row === undefined || row.ended_at !== null) return true;
    if (row.lifecycle_state === "archived" || row.lifecycle_state === "deleted") {
      yield* end(row);
      return true;
    }
    const now = yield* DateTime.now;
    const launchedAt = DateTime.makeUnsafe(row.launched_at);
    if (
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(launchedAt) >
      Duration.toMillis(Duration.days(LAUNCHED_FOLLOW_DAYS))
    ) {
      yield* end(row);
      return true;
    }
    // The thread there is read as its launcher; a launcher gone here would read as the
    // thread gone there, so it ends the follow instead.
    const launcher = yield* threads.getThreadShell(ThreadId.make(row.launcher_thread_id));
    if (launcher === null || launcher.deletedAt !== null) {
      yield* Effect.logInfo("launched-thread.launcher-gone", { environmentId, threadId });
      yield* end(row);
      return true;
    }
    const read = yield* forwarding
      .readThread(scopeFor(row), row.environment_id as EnvironmentId, {
        threadId: ThreadId.make(row.thread_id),
        limit: 1,
        runLimit: 1,
      })
      .pipe(
        Effect.map((read) => ({ gone: false as const, read })),
        Effect.catchIf(
          (error) => error.code === "thread_not_found",
          () => Effect.succeed({ gone: true as const }),
        ),
      );
    return yield* hookLock.withPermits(1)(
      Effect.gen(function* () {
        // Read again under the lock, so two looks never report one change twice.
        let current = (yield* readRow(environmentId, threadId)) ?? row;
        if (current.ended_at !== null) return true;
        if (read.gone) {
          if (current.lifecycle_state !== "deleted") {
            current = yield* emit(current, "launched_thread.lifecycle", "deleted", {
              lifecycle: "deleted",
              runId: current.run_id,
              runStatus: current.run_status,
            });
          }
          yield* end(current);
          return true;
        }
        const there = read.read.thread;
        const run = latestRun(read.read);
        // A run's end is reported before what the user did with the thread after it.
        if (
          run !== undefined &&
          isTerminal(run.status) &&
          (run.runId !== current.run_id || run.status !== current.run_status)
        ) {
          current = yield* emit(current, "launched_thread.run", runChange(run.status), {
            lifecycle: current.lifecycle_state,
            runId: run.runId,
            runStatus: run.status,
          });
        }
        const state: LifecycleState = there.archived
          ? "archived"
          : there.settled
            ? "settled"
            : "active";
        const change = lifecycleChange(current.lifecycle_state, state);
        if (change !== undefined) {
          current = yield* emit(current, "launched_thread.lifecycle", change, {
            lifecycle: state,
            runId: run?.runId ?? current.run_id,
            runStatus: run?.status ?? current.run_status,
          });
        }
        if (state === "archived") {
          yield* end(current);
          return true;
        }
        return false;
      }),
    );
  });

  const following = new Set<string>();

  /**
   * Polls a launched thread there until it is archived or deleted, at most once per thread. A
   * link refused for good stops it until the next start; an unreachable machine is retried.
   */
  const follow = (environmentId: string, threadId: string) =>
    Effect.suspend(() => {
      const key = `${environmentId}\n${threadId}`;
      if (following.has(key)) return Effect.void;
      following.add(key);
      return lookOnce(environmentId, threadId).pipe(
        Effect.repeat({ while: (done) => !done, schedule: lifecyclePoll }),
        Effect.catchIf(isFinal, (error) =>
          Effect.logWarning("launched-thread.follow-refused", {
            environmentId,
            threadId,
            reason: isMcpFailure(error) ? error.message : String(error),
          }),
        ),
        Effect.retry(followRetry),
        Effect.ignoreCause({ log: true }),
        Effect.ensuring(Effect.sync(() => following.delete(key))),
      );
    });

  const record: LaunchedThreadTracking["Service"]["record"] = Effect.fn(
    "LaunchedThreadTracking.record",
  )(
    function* (launcher, environmentId, launched) {
      if (environmentId === hereId) return;
      if (!(yield* enabled)) return;
      const decoded = decodeLaunched(launched);
      if (decoded._tag === "None") return;
      const threadId = decoded.value.threadId;
      const now = DateTime.formatIso(yield* DateTime.now);
      // A retried launch returns the same thread; it keeps its first record.
      yield* sql`
        INSERT INTO fork_launched_remote_threads (
          environment_id, thread_id, launcher_thread_id, launcher_provider_instance_id, launched_at
        ) VALUES (
          ${environmentId}, ${threadId}, ${launcher.threadId}, ${launcher.providerInstanceId}, ${now}
        )
        ON CONFLICT (environment_id, thread_id) DO NOTHING
      `;
      yield* follow(environmentId, threadId).pipe(Effect.forkIn(followers));
    },
    Effect.ignoreCause({ log: true }),
  );

  const start: LaunchedThreadTracking["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        if (!(yield* enabled)) return;
        const open = yield* sql<Pick<Row, "environment_id" | "thread_id">>`
          SELECT environment_id, thread_id FROM fork_launched_remote_threads
          WHERE ended_at IS NULL
        `;
        yield* Effect.forEach(
          open,
          (row) => follow(row.environment_id, row.thread_id).pipe(Effect.forkIn(followers)),
          { discard: true },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return LaunchedThreadTracking.of({ record, lookOnce, start });
});

export const layer = Layer.effect(LaunchedThreadTracking, make);
