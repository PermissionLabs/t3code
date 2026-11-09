import {
  NonNegativeInt,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type ThreadHookEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadHookCommands from "./ThreadHookCommands.ts";
import { forkParked } from "../serverActivation.ts";

const HookCursor = Schema.fromJsonString(Schema.Struct({ sequence: NonNegativeInt }));
const decodeCursor = Schema.decodeUnknownEffect(HookCursor);
const encodeCursor = Schema.encodeSync(HookCursor);
const CURSOR_FILE = "thread-hooks-cursor.json";

interface HookThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly role: "top-level" | "delegated-child";
  /** The thread that delegated this one; null for a top-level thread. */
  readonly parentThreadId: string | null;
  /** Where the parent lives: this environment, or the linked one a task came from. */
  readonly parentEnvironmentId: string | null;
  readonly settled: boolean;
  readonly archived: boolean;
  readonly deleted: boolean;
}

interface HookTask {
  readonly taskId: string;
  readonly childThreadId: string | null;
  readonly environmentId: string;
  readonly status: OrchestrationV2Subagent["status"];
}

/**
 * What a hook reads on stdin. Ids and states only: no titles, prompts, results or messages.
 * `eventId` names the change; a hook that must not act twice keys on it.
 */
export interface ThreadHookPayload extends ThreadHookCommands.ThreadHookPayloadBase {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly environmentId: string;
  /** The thread the event is about; for `delegated_task.*`, the parent that delegated it. */
  readonly thread: HookThread;
  /** Tasks this thread delegated that have no result yet. */
  readonly openChildren: ReadonlyArray<HookTask>;
  readonly task?: HookTask & {
    readonly childState: "active" | "settled" | "archived" | "deleted";
    /** The parent was settled when this happened; its agent is not woken for it. */
    readonly parentSettled: boolean;
  };
}

const sameInstant = (left: DateTime.Utc | null, right: DateTime.Utc) =>
  left !== null && DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/** The hook event a stored event is, and the thread it is about. */
const classify = (
  stored: OrchestrationV2StoredEvent,
):
  | {
      readonly kind: "thread";
      readonly event: ThreadHookEvent;
      readonly thread: OrchestrationV2AppThread;
    }
  | {
      readonly kind: "task";
      readonly event: ThreadHookEvent;
      readonly task: OrchestrationV2Subagent;
    }
  | undefined => {
  const { event } = stored;
  switch (event.type) {
    case "thread.settled":
    case "thread.unsettled":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return { kind: "thread", event: event.type, thread: event.payload };
    case "thread.pinned":
      // Pinning a settled thread makes it active again.
      return event.payload.unsettledAt != null &&
        sameInstant(event.payload.unsettledAt, event.occurredAt)
        ? { kind: "thread", event: "thread.unsettled", thread: event.payload }
        : undefined;
    case "subagent.updated": {
      const task = event.payload;
      if (task.origin !== "app_owned") return undefined;
      if (task.result !== null && sameInstant(task.completedAt, event.occurredAt))
        return { kind: "task", event: "delegated_task.completed", task };
      if (
        task.childLifecycle !== undefined &&
        sameInstant(task.childLifecycle.changedAt, event.occurredAt)
      )
        return { kind: "task", event: "delegated_task.child-lifecycle", task };
      return undefined;
    }
    default:
      return undefined;
  }
};

const hookThread = (thread: OrchestrationV2AppThread, hereId: EnvironmentId): HookThread => {
  const subagent = thread.lineage.relationshipToParent === "subagent";
  const delegated = subagent || thread.delegatedFrom !== undefined;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    role: delegated ? "delegated-child" : "top-level",
    parentThreadId: subagent
      ? thread.lineage.parentThreadId
      : (thread.delegatedFrom?.threadId ?? null),
    parentEnvironmentId: subagent ? hereId : (thread.delegatedFrom?.environmentId ?? null),
    settled: thread.settledOverride === "settled",
    archived: thread.archivedAt !== null,
    deleted: thread.deletedAt !== null,
  };
};

const hookTask = (task: OrchestrationV2Subagent, hereId: EnvironmentId): HookTask => ({
  taskId: task.id,
  childThreadId: task.childThreadId ?? task.remoteChild?.threadId ?? null,
  environmentId: task.remoteChild?.environmentId ?? hereId,
  status: task.status,
});

export class ThreadHooks extends Context.Service<
  ThreadHooks,
  {
    /** Hook payloads for one stored event; empty for events no hook can run on. */
    readonly payloadFor: (
      stored: OrchestrationV2StoredEvent,
    ) => Effect.Effect<ThreadHookPayload | undefined>;
    /** Runs the hooks for one stored event and saves it as the last one handled. */
    readonly handle: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void>;
    /** Runs every configured hook after the last event handled, then follows new ones. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/hooks/ThreadHooks") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const commands = yield* ThreadHookCommands.makeCommands;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  const cursorPath = path.join(config.stateDir, CURSOR_FILE);

  const openChildren = (threadId: OrchestrationV2AppThread["id"]) =>
    projections.getThreadRecords(threadId, ["subagents"]).pipe(
      Effect.map(({ subagents }) =>
        subagents
          .filter((task) => task.origin === "app_owned" && task.result === null)
          .map((task) => hookTask(task, hereId)),
      ),
      Effect.orElseSucceed((): ReadonlyArray<HookTask> => []),
    );

  const payloadFor: ThreadHooks["Service"]["payloadFor"] = Effect.fnUntraced(
    function* (stored) {
      const classified = classify(stored);
      if (classified === undefined) return undefined;
      const base = {
        version: 1 as const,
        event: classified.event,
        eventId: stored.event.id,
        sequence: stored.sequence,
        occurredAt: DateTime.formatIso(stored.event.occurredAt),
        environmentId: hereId,
      };
      if (classified.kind === "thread") {
        return {
          ...base,
          thread: hookThread(classified.thread, hereId),
          openChildren: yield* openChildren(classified.thread.id),
        } satisfies ThreadHookPayload;
      }
      const parent = yield* projections.getThread(classified.task.threadId);
      const thread = hookThread(parent, hereId);
      return {
        ...base,
        thread,
        openChildren: yield* openChildren(parent.id),
        task: {
          ...hookTask(classified.task, hereId),
          childState: classified.task.childLifecycle?.state ?? "active",
          parentSettled: thread.settled,
        },
      } satisfies ThreadHookPayload;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("building a thread hook event failed", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const readCursor = fs.readFileString(cursorPath).pipe(
    Effect.flatMap(decodeCursor),
    Effect.map(({ sequence }): number | undefined => sequence),
    Effect.orElseSucceed(() => undefined),
  );

  const writeCursor = (sequence: number) =>
    fs
      .writeFileString(cursorPath, encodeCursor({ sequence }))
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("saving the hook cursor failed", { cause })),
      );

  // One event at a time and in order, so a settle and its undo reach hooks as a pair.
  const handle: ThreadHooks["Service"]["handle"] = Effect.fnUntraced(function* (stored) {
    const payload = yield* payloadFor(stored);
    if (payload === undefined) return;
    yield* commands.run(payload);
    // Saved after its hooks ran, so a restart neither repeats nor skips an event.
    yield* writeCursor(stored.sequence);
  });

  const start: ThreadHooks["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // A first start begins now: hooks never run for history.
        const afterSequence = (yield* readCursor) ?? (yield* engine.latestEventSequence);
        yield* Stream.runForEach(
          engine.streamStoredEventsFrom({ afterSequence, bounded: false }),
          handle,
        );
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("the thread hook stream failed", { cause })),
      ),
    );

  return ThreadHooks.of({ payloadFor, handle, start });
});

export const layer = Layer.effect(ThreadHooks, make);
