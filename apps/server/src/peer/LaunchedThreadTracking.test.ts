import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type OrchestratorMcpThreadReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadHookCommands from "../hooks/ThreadHookCommands.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LaunchedThreadTracking from "./LaunchedThreadTracking.ts";
import * as PeerForwarding from "./PeerForwarding.ts";

const here = EnvironmentId.make("environment:mini-1");
const box = EnvironmentId.make("environment:macbook");
const router = ThreadId.make("thread:router");
const launchedThere = ThreadId.make("thread:on-macbook");
const launcher = {
  threadId: router,
  providerSessionId: "provider:router",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
};

interface There {
  readonly settled: boolean;
  readonly archived: boolean;
  readonly gone: boolean;
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly status: OrchestrationV2RunStatus;
  }>;
}

/** The thread on the other machine, as `t3_thread_read` there reports it. */
class RemoteThread extends Context.Service<
  RemoteThread,
  {
    readonly state: Ref.Ref<There>;
    readonly reads: Ref.Ref<number>;
    readonly launcherGone: Ref.Ref<boolean>;
    readonly hooked: Ref.Ref<ReadonlyArray<LaunchedThreadTracking.LaunchedThreadHookPayload>>;
  }
>()("t3/peer/LaunchedThreadTracking.test/RemoteThread") {}

const layerRemoteThread = Layer.effect(
  RemoteThread,
  Effect.gen(function* () {
    return RemoteThread.of({
      state: yield* Ref.make<There>({ settled: false, archived: false, gone: false, runs: [] }),
      reads: yield* Ref.make(0),
      launcherGone: yield* Ref.make(false),
      hooked: yield* Ref.make<ReadonlyArray<LaunchedThreadTracking.LaunchedThreadHookPayload>>([]),
    });
  }),
);

const readResult = (there: There) =>
  ({
    thread: {
      threadId: launchedThere,
      settled: there.settled,
      archived: there.archived,
      latestRunId: there.runs.at(-1)?.runId ?? null,
    },
    recentRuns: there.runs.map((run, index) => ({ ...run, ordinal: index + 1 })).toReversed(),
    items: [],
    nextPosition: null,
    hasMore: false,
  }) as unknown as OrchestratorMcpThreadReadResult;

const layerDependencies = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.mergeAll(
    Layer.effect(
      PeerForwarding.PeerForwarding,
      Effect.gen(function* () {
        const remote = yield* RemoteThread;
        return PeerForwarding.PeerForwarding.of({
          readThread: (_scope: unknown, environmentId: EnvironmentId) =>
            Effect.gen(function* () {
              assert.strictEqual(environmentId, box);
              yield* Ref.update(remote.reads, (count) => count + 1);
              const there = yield* Ref.get(remote.state);
              if (there.gone) {
                return yield* new OrchestratorMcpFailure({
                  code: "thread_not_found",
                  message: "The thread was not found.",
                });
              }
              return readResult(there);
            }),
        } as unknown as PeerForwarding.PeerForwarding["Service"]);
      }),
    ),
    Layer.effect(
      ThreadManagement.ThreadManagementService,
      Effect.gen(function* () {
        const remote = yield* RemoteThread;
        return {
          getThreadShell: (threadId: ThreadId) =>
            Ref.get(remote.launcherGone).pipe(
              Effect.map((gone) => (gone ? null : liveThreadShell(threadId))),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"];
      }),
    ),
    Layer.effect(
      ThreadHookCommands.ThreadHookCommands,
      Effect.gen(function* () {
        const remote = yield* RemoteThread;
        return ThreadHookCommands.ThreadHookCommands.of({
          run: (payload) =>
            Ref.update(remote.hooked, (all) => [
              ...all,
              payload as LaunchedThreadTracking.LaunchedThreadHookPayload,
            ]),
        });
      }),
    ),
  ).pipe(
    Layer.provideMerge(layerRemoteThread),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(here) }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const layerFor = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  LaunchedThreadTracking.layer.pipe(Layer.provideMerge(layerDependencies(settings)));

const look = Effect.gen(function* () {
  const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
  return yield* tracking.lookOnce(box, launchedThere);
});

const setThere = (change: Partial<There>) =>
  RemoteThread.pipe(
    Effect.flatMap((remote) => Ref.update(remote.state, (s) => ({ ...s, ...change }))),
  );

const hooked = RemoteThread.pipe(Effect.flatMap((remote) => Ref.get(remote.hooked)));

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly environment_id: string;
    readonly thread_id: string;
    readonly launcher_thread_id: string;
    readonly launched_at: string;
    readonly lifecycle_state: string;
    readonly event_count: number;
    readonly ended_at: string | null;
  }>`SELECT * FROM fork_launched_remote_threads`;
});

const recordLaunch = Effect.gen(function* () {
  const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
  yield* tracking.record(launcher, box, { threadId: launchedThere, runId: "run:1" });
});

const on = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    LaunchedThreadTracking.LaunchedThreadTracking | RemoteThread | SqlClient.SqlClient
  >,
) => effect.pipe(Effect.provide(layerFor({ launchedThreadTracking: true })));

describe("launched thread tracking", () => {
  it.effect("records a launch there once, and never one here", () =>
    on(
      Effect.gen(function* () {
        const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
        yield* recordLaunch;
        // A retried launch returns the same thread.
        yield* recordLaunch;
        yield* tracking.record(launcher, here, { threadId: ThreadId.make("thread:here") });
        const recorded = yield* rows;
        assert.strictEqual(recorded.length, 1);
        assert.deepInclude(recorded[0], {
          environment_id: box,
          thread_id: launchedThere,
          launcher_thread_id: router,
          lifecycle_state: "active",
          event_count: 0,
          ended_at: null,
        });
        assert.isString(recorded[0]!.launched_at);
      }),
    ),
  );

  it.effect("reports a run's end and the thread's lifecycle once each, in order", () =>
    on(
      Effect.gen(function* () {
        yield* recordLaunch;
        yield* setThere({ runs: [{ runId: "run:1", status: "running" }] });
        assert.isFalse(yield* look);
        assert.deepStrictEqual(yield* hooked, []);

        yield* setThere({ runs: [{ runId: "run:1", status: "completed" }], settled: true });
        assert.isFalse(yield* look);
        // The same state again reports nothing.
        assert.isFalse(yield* look);
        const [run, settled, ...rest] = yield* hooked;
        assert.deepStrictEqual(rest, []);
        assert.deepStrictEqual(run, {
          version: 1,
          event: "launched_thread.run",
          change: "completed",
          eventId: `launched-thread:${box}:${launchedThere}:1`,
          sequence: 1,
          occurredAt: run!.occurredAt,
          environmentId: box,
          thread: {
            threadId: launchedThere,
            role: "launched-remote",
            launcherThreadId: router,
            settled: false,
            archived: false,
            deleted: false,
            runStatus: "completed",
          },
        });
        assert.deepInclude(settled, {
          event: "launched_thread.lifecycle",
          change: "settled",
          sequence: 2,
          eventId: `launched-thread:${box}:${launchedThere}:2`,
        });
        assert.deepInclude(settled!.thread, { settled: true, runStatus: "completed" });

        // A new message there starts a run; its end and the un-settle are new changes.
        yield* setThere({
          settled: false,
          runs: [
            { runId: "run:1", status: "completed" },
            { runId: "run:2", status: "failed" },
          ],
        });
        assert.isFalse(yield* look);
        const later = (yield* hooked).slice(2);
        assert.deepStrictEqual(
          later.map((payload) => [payload.event, payload.change, payload.sequence]),
          [
            ["launched_thread.run", "failed", 3],
            ["launched_thread.lifecycle", "unsettled", 4],
          ],
        );

        yield* setThere({ archived: true });
        assert.isTrue(yield* look);
        const archived = (yield* hooked).at(-1)!;
        assert.deepInclude(archived, { event: "launched_thread.lifecycle", change: "archived" });
        assert.deepInclude(archived.thread, { archived: true, settled: false });
        const [row] = yield* rows;
        assert.isNotNull(row!.ended_at);
        // Archived ends the follow: nothing is read there again.
        const remote = yield* RemoteThread;
        const readsBefore = yield* Ref.get(remote.reads);
        assert.isTrue(yield* look);
        assert.strictEqual(yield* Ref.get(remote.reads), readsBefore);
        assert.strictEqual((yield* hooked).length, 5);
      }),
    ),
  );

  it.effect("reports a thread deleted there and stops", () =>
    on(
      Effect.gen(function* () {
        yield* recordLaunch;
        yield* setThere({ gone: true });
        assert.isTrue(yield* look);
        assert.isTrue(yield* look);
        const all = yield* hooked;
        assert.strictEqual(all.length, 1);
        assert.deepInclude(all[0], { event: "launched_thread.lifecycle", change: "deleted" });
        assert.deepInclude(all[0]!.thread, { deleted: true, runStatus: null });
      }),
    ),
  );

  it.effect("polls once a minute and stops after 14 days", () =>
    on(
      Effect.gen(function* () {
        const remote = yield* RemoteThread;
        yield* recordLaunch;
        yield* TestClock.adjust(Duration.minutes(3));
        // The follower record started looks at once and then every minute.
        assert.strictEqual(yield* Ref.get(remote.reads), 4);
        yield* TestClock.adjust(Duration.days(LaunchedThreadTracking.LAUNCHED_FOLLOW_DAYS + 1));
        assert.isNotNull((yield* rows)[0]!.ended_at);
        const reads = yield* Ref.get(remote.reads);
        yield* setThere({ settled: true });
        yield* TestClock.adjust(Duration.days(1));
        assert.isTrue(yield* look);
        assert.deepStrictEqual(yield* hooked, []);
        assert.strictEqual(yield* Ref.get(remote.reads), reads);
      }),
    ),
  );

  it.effect("stops when the thread that launched it is deleted here", () =>
    on(
      Effect.gen(function* () {
        yield* recordLaunch;
        const remote = yield* RemoteThread;
        yield* Ref.set(remote.launcherGone, true);
        assert.isTrue(yield* look);
        // Not mistaken for the thread there being deleted.
        assert.deepStrictEqual(yield* hooked, []);
        assert.strictEqual(yield* Ref.get(remote.reads), 0);
      }),
    ),
  );
});

it.effect("resumes after a restart without reporting a change again", () =>
  Effect.gen(function* () {
    const dependencies = yield* Layer.build(layerDependencies({ launchedThreadTracking: true }));
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | LaunchedThreadTracking.LaunchedThreadTracking
        | RemoteThread
        | SqlClient.SqlClient
        | Scope.Scope
      >,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Each build is a new server over the same database.
          const context = yield* Layer.build(LaunchedThreadTracking.layer);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ).pipe(Effect.provide(dependencies));

    yield* run(recordLaunch);
    yield* run(
      Effect.gen(function* () {
        yield* setThere({ runs: [{ runId: "run:1", status: "completed" }], settled: true });
        // The follower record started reads it on its first look.
        const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
        yield* tracking.lookOnce(box, launchedThere);
      }),
    );
    assert.strictEqual((yield* run(hooked)).length, 2);

    // A restart follows it again from what it last reported.
    yield* run(
      Effect.gen(function* () {
        const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
        yield* tracking.start();
        yield* TestClock.adjust(Duration.seconds(1));
        const remote = yield* RemoteThread;
        assert.isAbove(yield* Ref.get(remote.reads), 1);
        assert.strictEqual((yield* hooked).length, 2);

        // The next poll reports what changed there since.
        yield* setThere({ archived: true });
        yield* TestClock.adjust(Duration.minutes(1));
        const all = yield* hooked;
        assert.deepStrictEqual(
          all.map((payload) => [payload.change, payload.sequence]),
          [
            ["completed", 1],
            ["settled", 2],
            ["archived", 3],
          ],
        );
      }),
    );
    const [row] = yield* run(rows);
    assert.isNotNull(row!.ended_at);
  }).pipe(
    Effect.provideService(LaunchedThreadTracking.LaunchedPollSchedule, Schedule.spaced("1 minute")),
    Effect.scoped,
  ),
);

describe("launched thread tracking while off", () => {
  it.effect("records, reads and reports nothing", () =>
    Effect.gen(function* () {
      const tracking = yield* LaunchedThreadTracking.LaunchedThreadTracking;
      yield* recordLaunch;
      assert.deepStrictEqual(yield* rows, []);
      yield* tracking.start();
      yield* setThere({ settled: true, runs: [{ runId: "run:1", status: "completed" }] });
      assert.isTrue(yield* look);
      yield* TestClock.adjust(Duration.minutes(5));
      assert.deepStrictEqual(yield* hooked, []);
      assert.strictEqual(yield* Ref.get((yield* RemoteThread).reads), 0);
    }).pipe(Effect.provide(layerFor({}))),
  );
});
