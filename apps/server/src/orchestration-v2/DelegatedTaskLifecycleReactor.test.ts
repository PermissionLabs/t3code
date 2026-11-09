import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskLifecycleReactor from "./DelegatedTaskLifecycleReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for lifecycle records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = DelegatedTaskLifecycleReactor.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "delegated-task-lifecycle" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provide(
    Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: () => Effect.void,
      take: Effect.never,
    }),
  ),
  Layer.provide(ServerSettings.layerTest({ delegatedTaskLifecycle: true })),
);

const createThread = (threadId: ThreadId, title: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:delegated-task-lifecycle"),
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return (yield* orchestrator.getThreadProjection(threadId)).thread;
  });

it.layer(layerTest)("a delegated task's thread here", (it) => {
  it.effect("tells its parent when it is settled and active again, once each", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const reactor = yield* DelegatedTaskLifecycleReactor.DelegatedTaskLifecycleReactor;
      const now = yield* DateTime.now;
      const parent = yield* createThread(ThreadId.make("thread:lifecycle-parent"), "Parent");
      const created = yield* createThread(ThreadId.make("thread:lifecycle-child"), "Child");
      const taskId = NodeId.make("node:lifecycle-task");
      yield* sink.write({
        commandId: CommandId.make("command:seed:lifecycle"),
        events: [
          {
            id: EventId.make("event:seed-child-lineage:lifecycle"),
            type: "thread.metadata-updated",
            threadId: created.id,
            occurredAt: now,
            payload: {
              ...created,
              createdBy: "agent",
              creationSource: "mcp",
              lineage: {
                parentThreadId: parent.id,
                relationshipToParent: "subagent",
                rootThreadId: parent.id,
              },
            },
          },
          {
            id: EventId.make("event:seed-task:lifecycle"),
            type: "subagent.updated",
            threadId: parent.id,
            nodeId: taskId,
            driver,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId: parent.id,
              runId: null,
              parentNodeId: NodeId.make("node:lifecycle-parent-root"),
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: created.id,
              nativeTaskRef: null,
              prompt: "Check the build.",
              title: "Build check",
              model: null,
              status: "completed",
              result: "Green.",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      const changeChild = (type: "thread.settle" | "thread.unsettle", name: string) =>
        orchestrator
          .dispatch(
            type === "thread.settle"
              ? { type, commandId: CommandId.make(`command:${name}`), threadId: created.id }
              : {
                  type,
                  commandId: CommandId.make(`command:${name}`),
                  threadId: created.id,
                  reason: "user",
                },
          )
          .pipe(
            Effect.map((result) => result.storedEvents.map((stored) => stored.event)),
            Effect.tap((events) => Effect.forEach(events, reactor.handle, { discard: true })),
          );
      const read = orchestrator.getThreadProjection(parent.id).pipe(
        Effect.map((projection) => ({
          state: projection.subagents.find((task) => task.id === taskId)?.childLifecycle?.state,
          notices: projection.messages
            .filter((message) => message.notification?.source.kind === "delegated_task")
            .map((message) => message.text),
        })),
      );

      const settled = yield* changeChild("thread.settle", "settle-child");
      // The same event seen again, as after a replay, tells the parent nothing more.
      yield* Effect.forEach(settled, reactor.handle, { discard: true });
      const afterSettle = yield* read;
      assert.equal(afterSettle.state, "settled");
      assert.equal(afterSettle.notices.length, 1);
      assert.include(
        afterSettle.notices[0] ?? "",
        `Delegated task ${taskId} (Build check) [completed]: its thread ${created.id} was settled.`,
      );

      yield* changeChild("thread.unsettle", "unsettle-child");
      const afterUnsettle = yield* read;
      assert.equal(afterUnsettle.state, "active");
      assert.equal(afterUnsettle.notices.length, 2);
      assert.isTrue(afterUnsettle.notices.some((text) => text.includes("is active again")));
    }),
  );
});
