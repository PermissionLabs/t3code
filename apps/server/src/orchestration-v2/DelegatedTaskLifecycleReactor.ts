import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DelegatedTaskChildState,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** What a delegated task's thread is now, as `delegated_task.child-lifecycle` records it. */
const delegatedChildState = (
  thread: Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt" | "settledOverride">,
): OrchestrationV2DelegatedTaskChildState =>
  thread.deletedAt !== null
    ? "deleted"
    : thread.archivedAt !== null
      ? "archived"
      : thread.settledOverride === "settled"
        ? "settled"
        : "active";

/** The thread an event changed the settled, archived or deleted state of; pinning unsettles. */
const lifecycleThread = (event: OrchestrationV2DomainEvent) => {
  switch (event.type) {
    case "thread.settled":
    case "thread.unsettled":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.pinned":
      return event.payload;
    default:
      return undefined;
  }
};

/**
 * Tells the parent of a delegated task here when its child thread is settled, made active
 * again, archived or deleted. Tasks in a linked environment are followed by RemoteDelegation.
 */
export class DelegatedTaskLifecycleReactor extends Context.Service<
  DelegatedTaskLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskLifecycleReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const handle: DelegatedTaskLifecycleReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const child = lifecycleThread(event);
      if (child === undefined) return;
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null || child.lineage.relationshipToParent !== "subagent") return;
      if (!(yield* settings.getSettings).delegatedTaskLifecycle) return;
      const { subagents } = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
      const task = subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.childThreadId === child.id,
      );
      if (task === undefined) return;
      const state = delegatedChildState(child);
      if ((task.childLifecycle?.state ?? "active") === state) return;
      yield* engine.dispatch({
        type: "delegated_task.child-lifecycle",
        commandId: CommandId.make(
          `server:delegated-task-lifecycle:${task.id}:${state}:${DateTime.toEpochMillis(event.occurredAt)}`,
        ),
        parentThreadId,
        taskId: task.id,
        state,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telling a parent about its delegated task's thread failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskLifecycleReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task lifecycle event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskLifecycleReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskLifecycleReactor, make);
