import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadHooks from "./ThreadHooks.ts";

const here = EnvironmentId.make("environment:mini-1");
const box = EnvironmentId.make("environment:mini-2");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for hook events"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerFor = (settings: Parameters<typeof ServerSettings.layerTest>[0]) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return ThreadHooks.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "thread-hooks" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false, delegatedTaskLifecycle: true },
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
        offer: () => Effect.void,
        take: Effect.never,
      }),
    ),
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(here),
      }),
    ),
    Layer.provide(ProcessRunner.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-hooks-" })),
    Layer.provideMerge(NodeServices.layer),
  );
};

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:router"),
      title: "A title hooks never see",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return (yield* orchestrator.getThreadProjection(threadId)).thread;
  });

const task = (
  id: string,
  parentThreadId: ThreadId,
  child: Pick<OrchestrationV2Subagent, "childThreadId" | "remoteChild">,
  now: DateTime.Utc,
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId: parentThreadId,
  runId: null,
  parentNodeId: NodeId.make(`${id}:parent`),
  origin: "app_owned",
  createdBy: "agent",
  driver,
  providerInstanceId: instanceId,
  providerThreadId: null,
  nativeTaskRef: null,
  prompt: "A prompt hooks never see.",
  title: null,
  model: null,
  status: "running",
  result: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  ...child,
});

/** A router thread with a running child here and one on a linked machine. */
const seedRouter = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const router = yield* createThread(ThreadId.make("thread:router"));
  const created = yield* createThread(ThreadId.make("thread:child-here"));
  const childHere = task("node:task-here", router.id, { childThreadId: created.id }, now);
  const childThere = task(
    "node:task-there",
    router.id,
    {
      childThreadId: null,
      remoteChild: { environmentId: box, threadId: ThreadId.make("thread:on-box"), label: "Box" },
    },
    now,
  );
  yield* sink.write({
    commandId: CommandId.make("command:seed:router"),
    events: [
      {
        id: EventId.make("event:seed-child-lineage"),
        type: "thread.metadata-updated",
        threadId: created.id,
        occurredAt: now,
        payload: {
          ...created,
          lineage: {
            parentThreadId: router.id,
            relationshipToParent: "subagent",
            rootThreadId: router.id,
          },
        },
      },
      ...[childHere, childThere].map((payload) => ({
        id: EventId.make(`event:seed:${payload.id}`),
        type: "subagent.updated" as const,
        threadId: router.id,
        nodeId: payload.id,
        driver,
        occurredAt: now,
        payload,
      })),
    ],
  });
  return { router, child: created, childHere, childThere };
});

const stored = (dispatched: Orchestrator.OrchestratorV2DispatchResult) =>
  dispatched.storedEvents as ReadonlyArray<OrchestrationV2StoredEvent>;

it.layer(layerFor({}))("thread hook events", (it) => {
  it.effect("describe a settle and its undo, with the open children and who is whose", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hooks = yield* ThreadHooks.ThreadHooks;
      const { router, child, childHere, childThere } = yield* seedRouter;
      const payloadsOf = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
        Effect.forEach(events, hooks.payloadFor).pipe(
          Effect.map((payloads) => payloads.filter((payload) => payload !== undefined)),
        );

      const [settled] = yield* payloadsOf(
        stored(
          yield* orchestrator.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:settle-router"),
            threadId: router.id,
          }),
        ),
      );
      assert.deepInclude(settled, {
        version: 1,
        event: "thread.settled",
        environmentId: here,
        thread: {
          threadId: router.id,
          projectId: ProjectId.make("project:router"),
          role: "top-level",
          parentThreadId: null,
          parentEnvironmentId: null,
          settled: true,
          archived: false,
          deleted: false,
        },
      });
      assert.sameDeepMembers(
        [...(settled?.openChildren ?? [])],
        [
          { taskId: childHere.id, childThreadId: child.id, environmentId: here, status: "running" },
          {
            taskId: childThere.id,
            childThreadId: ThreadId.make("thread:on-box"),
            environmentId: box,
            status: "running",
          },
        ],
      );
      // Titles, prompts and results never reach a hook.
      assert.notInclude(JSON.stringify(settled), "never see");

      const [undone] = yield* payloadsOf(
        stored(
          yield* orchestrator.dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make("command:unsettle-router"),
            threadId: router.id,
            reason: "user",
          }),
        ),
      );
      assert.equal(undone?.event, "thread.unsettled");
      assert.equal(undone?.thread.settled, false);
      assert.isAbove(undone?.sequence ?? 0, settled?.sequence ?? 0);

      const [childSettled] = yield* payloadsOf(
        stored(
          yield* orchestrator.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:settle-child"),
            threadId: child.id,
          }),
        ),
      );
      assert.deepInclude(childSettled?.thread, {
        threadId: child.id,
        role: "delegated-child",
        parentThreadId: router.id,
        parentEnvironmentId: here,
      });
    }),
  );

  it.effect("report a child's result that reaches a settled parent", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const hooks = yield* ThreadHooks.ThreadHooks;
      const router = yield* createThread(ThreadId.make("thread:router-2"));
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const remote = task(
        "node:task-overnight",
        router.id,
        {
          childThreadId: null,
          remoteChild: {
            environmentId: box,
            threadId: ThreadId.make("thread:overnight"),
            label: "Box",
          },
        },
        now,
      );
      yield* sink.write({
        commandId: CommandId.make("command:seed:router-2"),
        events: [
          {
            id: EventId.make("event:seed:overnight"),
            type: "subagent.updated",
            threadId: router.id,
            nodeId: remote.id,
            driver,
            occurredAt: now,
            payload: remote,
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:settle-router-2"),
        threadId: router.id,
      });
      const completed = yield* orchestrator.dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make("command:complete-overnight"),
        parentThreadId: router.id,
        taskId: remote.id,
        status: "completed",
        result: "A result hooks never see.",
        stoppedThere: "ran-out",
      });
      const payloads = (yield* Effect.forEach(stored(completed), hooks.payloadFor)).filter(
        (payload) => payload !== undefined,
      );
      assert.equal(payloads.length, 1);
      assert.deepInclude(payloads[0], { event: "delegated_task.completed", openChildren: [] });
      assert.deepEqual(payloads[0]?.task, {
        taskId: remote.id,
        childThreadId: ThreadId.make("thread:overnight"),
        environmentId: box,
        status: "completed",
        childState: "active",
        parentSettled: true,
      });
      assert.notInclude(JSON.stringify(payloads), "never see");
    }),
  );
});

it.live("run in order with the event on stdin, and a failing hook stops nothing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const hooks = yield* ThreadHooks.ThreadHooks;
    const out = path.join(yield* fs.makeTempDirectoryScoped(), "events.jsonl");
    process.env.T3_HOOK_TEST_OUT = out;
    yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.T3_HOOK_TEST_OUT));
    const router = yield* createThread(ThreadId.make("thread:router-live"));
    const run = (dispatched: Orchestrator.OrchestratorV2DispatchResult) =>
      Effect.forEach(stored(dispatched), hooks.handle, { discard: true });

    const settle = yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("command:settle-live"),
      threadId: router.id,
    });
    yield* run(settle);
    yield* run(
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("command:unsettle-live"),
        threadId: router.id,
        reason: "user",
      }),
    );
    const lines = (yield* fs.readFileString(out)).trim().split("\n");
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as ThreadHooks.ThreadHookPayload).event),
      ["thread.settled", "thread.unsettled"],
    );
    // The last event handled is saved, so a restart starts after it.
    const cursor = yield* fs.readFileString(path.join(config.stateDir, "thread-hooks-cursor.json"));
    assert.deepEqual(JSON.parse(cursor), {
      sequence: (JSON.parse(lines[1]!) as ThreadHooks.ThreadHookPayload).sequence,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerFor({
        threadHooks: [
          { events: ["thread.settled", "thread.unsettled"], command: `cat >> "$T3_HOOK_TEST_OUT"` },
          { events: ["thread.settled"], command: "exit 3" },
          { events: ["thread.settled"], command: "sleep 5", timeoutMs: 100 },
        ],
      }),
    ),
  ),
);
