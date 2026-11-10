import * as DocumentText from "../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LinkFenceTakeover from "../orchestration-v2/LinkFenceTakeover.ts";
import { assertNotLinked, callerLinkOrigin, launchSourceFromLink } from "./linkOrigin.ts";
import type { Caller } from "./threadAccess.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";

// A linked environment's session drives this one's real orchestrator through
// its real T3 tools. What the link starts carries its origin, and the link
// changes only that.

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:link-origin");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for these commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "link-origin" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerOrchestration = ThreadManagement.layer.pipe(
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
);

/** Launches dispatch the real thread.create, and nothing more: no workspace, no run. */
const layerLaunches = Layer.effect(
  ThreadLaunch.ThreadLaunchService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return ThreadLaunch.ThreadLaunchService.of({
      launch: (input: ThreadLaunch.ThreadLaunchInput) =>
        threads
          .dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: input.threadId!,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
            ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
            ...(input.launchedFrom === undefined ? {} : { launchedFrom: input.launchedFrom }),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(
            Effect.flatMap(() => threads.getThreadProjection(input.threadId!)),
            Effect.map((projection) => ({
              threadId: input.threadId!,
              projection,
              resumed: false,
            })),
            Effect.orDie,
          ),
    } as unknown as ThreadLaunch.ThreadLaunchService["Service"]);
  }),
);

const layerTools = Layer.mergeAll(
  McpHttpServer.layerOrchestratorToolkit,
  McpHttpServer.layerThreadToolkit,
  McpHttpServer.layerProjectRegistration,
).pipe(
  Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(layerLaunches),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedNone,
      create: (input) =>
        Effect.succeed({
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:00.000Z",
          deletedAt: null,
        }),
      update: (input) =>
        Effect.succeed({
          id: input.projectId,
          title: input.title ?? "Untitled",
          workspaceRoot: "/p/t3code",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
  Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
  ),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Effect.succeed({
          cwd: input.destinationPath,
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
          repository: null,
        }),
    }),
  ),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-origin-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "link-origin", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "link-origin", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  sessionId: string,
  linked: boolean,
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:box"),
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, label: `T3 Code · ${sessionId}`, access, linked },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
});
const laptop = clientScope("laptop", true, "auto");
const desk = clientScope("desk", true, "auto");
const trusted = clientScope("trusted", true, "full-access");
const claudeCode = clientScope("claude-code", false, "full-access");

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const failureCode = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code: string }).code
    : undefined;
};

const launch = (
  scope: McpInvocationContext.McpInvocationScope,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  call(scope, "t3_thread_launch", {
    projectId,
    title,
    modelSelection: { instanceId, model: "gpt-5" },
    ...extra,
  }).pipe(
    Effect.map((result) => {
      assert.equal(result.isError, false, JSON.stringify(result.content));
      return (result.structuredContent as { threadId: ThreadId }).threadId;
    }),
  );

const usersOwnThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:users-own");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:users-own"),
    threadId,
    projectId,
    title: "The user's own",
    modelSelection: { instanceId, model: "gpt-5" },
    // Within an `auto` link's modes, so only the fence decides.
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

it.layer(Layer.provideMerge(layerTools, layerOrchestration))("work a link starts", (it) => {
  it.effect("is stamped, and so is the work it derives", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const launched = yield* launch(laptop, "Started from the laptop");
      const shell = yield* projections.getThreadShell(launched);
      assert.deepEqual(shell?.linkOrigin, {
        sessionId: "laptop",
        label: "T3 Code · laptop",
        access: "auto",
      });

      // A subagent of it and a fork of it are built from its thread, origin included.
      const thread = (yield* ThreadManagement.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadProjection(launched)),
      )).thread;
      const child = makeSubagentChildThread({
        parentThread: thread,
        childThreadId: ThreadId.make("thread:child"),
        parentNodeId: NodeId.make("node:child"),
        activeProviderThreadId: null,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        title: "Child",
        now: thread.createdAt,
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.deepEqual(child.linkOrigin, shell?.linkOrigin);
      const fork = yield* ThreadForkService.ThreadForkServiceV2.pipe(
        Effect.flatMap((forks) =>
          forks.plan({
            sourceProjection: { thread },
            sourceRun: { id: RunId.make("run:source"), status: "completed" } as OrchestrationV2Run,
            sourceProviderThread: undefined,
            canonicalSourcePoint: { threadId: launched },
            transferId: ContextTransferId.make("transfer:fork"),
            targetThreadId: ThreadId.make("thread:fork"),
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: thread.createdAt,
          }),
        ),
        Effect.provide(ThreadForkService.layer),
      );
      assert.deepEqual(fork.targetThread.linkOrigin, shell?.linkOrigin);

      // An ordinary outside agent's launch is not a link's.
      const plain = yield* launch(claudeCode, "Started by Claude Code");
      assert.equal((yield* projections.getThreadShell(plain))?.linkOrigin, undefined);

      // A link's delegated task names its parent there; only a link's launch may.
      const delegatedFrom = {
        environmentId: "environment-laptop",
        threadId: "thread:laptop-parent",
        title: "Laptop parent",
      };
      const task = yield* launch(laptop, "Delegated from the laptop", { delegatedFrom });
      assert.deepEqual((yield* projections.getThreadShell(task))?.delegatedFrom, delegatedFrom);
      const claimed = yield* launch(claudeCode, "Claims a parent", { delegatedFrom });
      assert.equal((yield* projections.getThreadShell(claimed))?.delegatedFrom, undefined);
    }),
  );

  it.effect("changes only that link's threads below full access", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const ownLaunch = yield* launch(laptop, "The laptop's");
      const rename = (scope: McpInvocationContext.McpInvocationScope, threadId: ThreadId) =>
        call(scope, "t3_thread_update", {
          threadId,
          action: "rename",
          title: `Renamed by ${scope.client!.sessionId}`,
        });

      // The link may change what it started.
      assert.equal((yield* rename(laptop, ownLaunch)).isError, false);
      assert.equal((yield* projections.getThreadShell(ownLaunch))?.title, "Renamed by laptop");
      // Not the user's own thread, nor another link's.
      assert.equal(failureCode(yield* rename(laptop, users)), "capability_denied");
      assert.equal(failureCode(yield* rename(desk, ownLaunch)), "capability_denied");
      assert.equal((yield* projections.getThreadShell(users))?.title, "The user's own");
      // An ordinary outside agent is not fenced.
      assert.equal((yield* rename(claudeCode, users)).isError, false);
      // Naming this environment's own id is still this environment's thread.
      for (const [name, args] of [
        ["t3_thread_send", { message: "From the laptop." }],
        ["t3_thread_interrupt", {}],
      ] as const) {
        const result = yield* call(laptop, name, {
          ...args,
          environmentId: laptop.environmentId,
          threadId: users,
        });
        assert.equal(failureCode(result), "capability_denied", name);
      }

      // Nor scheduled tasks, which belong to no thread.
      assert.equal(
        failureCode(yield* call(laptop, "delete_scheduled_task", { scheduledTaskId: "any" })),
        "capability_denied",
      );

      // Reads are not fenced.
      const read = yield* call(laptop, "t3_thread_read", { threadId: users });
      assert.equal(read.isError, false);
    }),
  );

  it.effect("is not fenced when the link has full access, but still says where it came from", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const launched = yield* launch(trusted, "Started from the desk");
      assert.deepEqual((yield* projections.getThreadShell(launched))?.linkOrigin, {
        sessionId: "trusted",
        label: "T3 Code · trusted",
        access: "full-access",
      });

      const renamed = yield* call(trusted, "t3_thread_update", {
        threadId: users,
        action: "rename",
        title: "Renamed from the desk",
      });
      assert.equal(renamed.isError, false, JSON.stringify(renamed.content));
      for (const [name, args] of [
        ["t3_project_update", { projectId, title: "The desk's now" }],
        ["t3_project_create", { title: "t3code", workspaceRoot: "/p/t3code" }],
      ] as const) {
        const changed = yield* call(trusted, name, args);
        assert.equal(changed.isError, false, `${name}: ${JSON.stringify(changed.content)}`);
      }
    }),
  );
});

// A person here takes over a thread a fenced link started by messaging it from their own client.

/** What the WebSocket path needs beyond the orchestration the tools already share. */
const layerUserClient = Layer.mergeAll(
  layerLaunches,
  DocumentText.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-takeover-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const userSession = { sessionId: "session:box-user" };

/** A message typed in one of this environment's own apps, sent the way `ws.ts` sends it. */
const messageFromUser = (threadId: ThreadId, key: string, extra: Partial<MessageCommand> = {}) =>
  LinkFenceTakeover.dispatchFromUserClient(
    {
      type: "message.dispatch",
      commandId: CommandId.make(`user-message:${key}`),
      threadId,
      messageId: MessageId.make(`message:user:${key}`),
      text: "I'll take it from here.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
      ...extra,
    },
    userSession,
  ).pipe(Effect.provide(layerUserClient));
type MessageCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const setTakeover = (enabled: boolean) =>
  ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((settings) =>
      settings.updateSettings({ releaseLinkFenceOnUserTakeover: enabled }),
    ),
  );

/** The caller an agent running in `threadId` is, as each of its tool calls loads it. */
const threadCaller = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const caller = (yield* projections.getThreadShell(threadId)) ?? undefined;
    return {
      scope: {
        environmentId: EnvironmentId.make("environment:box"),
        requestNamespace: `thread:${threadId}`,
        thread: { threadId, providerSessionId: "session:provider", providerInstanceId: instanceId },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      },
      caller,
    } satisfies Pick<Caller, "scope" | "caller">;
  });

const fenced = (threadId: ThreadId) =>
  threadCaller(threadId).pipe(
    Effect.flatMap((caller) =>
      Effect.exit(assertNotLinked(caller, "use this environment's links")),
    ),
    Effect.map((exit) => exit._tag === "Failure"),
  );

const releaseOf = (threadId: ThreadId) =>
  ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThreadShell(threadId)),
    Effect.map((shell) => shell?.linkFenceRelease ?? undefined),
  );

it.layer(Layer.provideMerge(layerTools, layerOrchestration))("a person here", (it) => {
  it.effect("takes over a fenced link's thread by messaging it, and its agents act as here", () =>
    Effect.gen(function* () {
      yield* setTakeover(true);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const launched = yield* launch(laptop, "Handed to the box user");
      assert.isTrue(yield* fenced(launched));

      yield* messageFromUser(launched, "takeover");

      const release = yield* releaseOf(launched);
      assert.deepEqual(release?.releasedBy, { kind: "local-user", sessionId: "session:box-user" });
      assert.isDefined(release?.releasedAt);
      const shell = yield* projections.getThreadShell(launched);
      // Where it came from stays; only the fence is gone.
      assert.equal(shell?.linkOrigin?.sessionId, "laptop");
      // The message went out as well.
      assert.isTrue((shell?.latestUserMessageAt ?? null) !== null);

      // Its agents act for no link: this environment's links, threads and projects are theirs.
      const caller = yield* threadCaller(launched);
      assert.equal(callerLinkOrigin(caller), undefined);
      assert.isFalse(yield* fenced(launched));

      // The laptop's link may no longer change it: it is the box user's thread now.
      const renamed = yield* call(laptop, "t3_thread_update", {
        threadId: launched,
        action: "rename",
        title: "Renamed by the laptop",
      });
      assert.equal(failureCode(renamed), "capability_denied");
      const sent = yield* call(laptop, "t3_thread_send", {
        threadId: launched,
        message: "Back to me.",
      });
      assert.equal(failureCode(sent), "capability_denied");
      // And the users's own thread is still out of the link's reach.
      assert.equal(
        failureCode(
          yield* call(laptop, "t3_thread_update", {
            threadId: users,
            action: "rename",
            title: "x",
          }),
        ),
        "capability_denied",
      );

      // A second message records nothing new.
      yield* messageFromUser(launched, "again");
      assert.deepEqual(yield* releaseOf(launched), release);
    }),
  );

  it.effect("is never stood in for by anything a link sends", () =>
    Effect.gen(function* () {
      yield* setTakeover(true);
      const launched = yield* launch(laptop, "Still the laptop's");

      // The link's own agent messages it, as often as it likes.
      for (const [index, mode] of (["queue", "auto", "queue"] as const).entries()) {
        const sent = yield* call(laptop, "t3_thread_send", {
          threadId: launched,
          message: `From the laptop ${index}.`,
          mode,
        });
        assert.equal(sent.isError, false, JSON.stringify(sent.content));
      }
      // Another link may not message it at all, and an outside agent here is not a person.
      assert.equal(
        failureCode(yield* call(desk, "t3_thread_send", { threadId: launched, message: "Hi." })),
        "capability_denied",
      );
      const outside = yield* call(claudeCode, "t3_thread_send", {
        threadId: launched,
        message: "From an outside agent.",
      });
      assert.equal(outside.isError, false, JSON.stringify(outside.content));
      // Nor does a message a client relays rather than types: a guest's, a notice.
      assert.isFalse(
        LinkFenceTakeover.isUserAuthoredMessage({
          type: "message.dispatch",
          commandId: CommandId.make("guest"),
          threadId: launched,
          messageId: MessageId.make("message:guest"),
          text: "",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          guestMessageId: "guest-message:1" as never,
          dispatchMode: { type: "queue_after_active" },
        }),
      );
      assert.isFalse(
        LinkFenceTakeover.isUserAuthoredMessage({
          type: "message.dispatch",
          commandId: CommandId.make("agent"),
          threadId: launched,
          messageId: MessageId.make("message:agent"),
          text: "",
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: "queue_after_active" },
        }),
      );

      assert.equal(yield* releaseOf(launched), undefined);
      assert.isTrue(yield* fenced(launched));
      assert.equal(
        (yield* EventStore.EventStoreV2.pipe(
          Effect.flatMap((events) => Stream.runCollect(events.read({ threadId: launched }))),
          Effect.provide(EventStore.layer),
        )).filter(
          ({ event }) => event.type === "thread.link-fence-released" && event.threadId === launched,
        ).length,
        0,
      );
    }),
  );

  it.effect("takes over nothing while the setting is off", () =>
    Effect.gen(function* () {
      yield* setTakeover(false);
      const launched = yield* launch(laptop, "Setting off");
      yield* messageFromUser(launched, "setting-off");
      assert.equal(yield* releaseOf(launched), undefined);
      assert.isTrue(yield* fenced(launched));
      // The link keeps what it had.
      const renamed = yield* call(laptop, "t3_thread_update", {
        threadId: launched,
        action: "rename",
        title: "Still the laptop's to rename",
      });
      assert.equal(renamed.isError, false, JSON.stringify(renamed.content));
    }),
  );

  it.effect("keeps the takeover after a restart", () =>
    Effect.gen(function* () {
      yield* setTakeover(true);
      const launched = yield* launch(laptop, "Survives a restart");
      yield* messageFromUser(launched, "restart");
      const release = yield* releaseOf(launched);
      assert.isDefined(release);

      // The event is stored under its own command, and decodes back.
      const stored = yield* EventStore.EventStoreV2.pipe(
        Effect.flatMap((events) =>
          Stream.runCollect(
            events.readByCommandId({
              commandId: LinkFenceTakeover.releaseCommandId("user-message:restart"),
            }),
          ),
        ),
        Effect.provide(EventStore.layer),
      );
      assert.deepEqual(
        stored.map(({ event }) => event.type),
        ["thread.link-fence-released"],
      );

      // A fresh projection store over the same database, as after a restart, still has it,
      // and turning the setting off later does not fence the thread again.
      yield* setTakeover(false);
      const reopened = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.flatMap((projections) => projections.getThreadShell(launched)),
        Effect.provide(ProjectionStore.layer),
      );
      assert.deepEqual(reopened?.linkFenceRelease, release);
      const thread = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.flatMap((projections) => projections.getThread(launched)),
        Effect.provide(ProjectionStore.layer),
      );
      assert.deepEqual(thread.linkFenceRelease, release);
      assert.isFalse(yield* fenced(launched));
    }),
  );

  it.effect("leaves every other link's threads fenced", () =>
    Effect.gen(function* () {
      yield* setTakeover(true);
      const laptops = yield* launch(laptop, "The laptop's, taken over");
      const desks = yield* launch(desk, "The desk's, left alone");
      const laptopsOther = yield* launch(laptop, "The laptop's, left alone");
      yield* messageFromUser(laptops, "one-of-many");

      assert.isDefined(yield* releaseOf(laptops));
      assert.equal(yield* releaseOf(desks), undefined);
      assert.equal(yield* releaseOf(laptopsOther), undefined);
      assert.isTrue(yield* fenced(desks));
      assert.isTrue(yield* fenced(laptopsOther));
      // Each link still changes only its own untaken threads.
      assert.equal(
        (yield* call(desk, "t3_thread_update", {
          threadId: desks,
          action: "rename",
          title: "The desk's still",
        })).isError,
        false,
      );
      assert.equal(
        failureCode(
          yield* call(desk, "t3_thread_update", {
            threadId: laptopsOther,
            action: "rename",
            title: "x",
          }),
        ),
        "capability_denied",
      );

      // A fork of the taken-over thread starts fenced again: a link cannot fork its way out.
      const thread = (yield* ThreadManagement.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadProjection(laptops)),
      )).thread;
      assert.isDefined(thread.linkFenceRelease);
      const fork = yield* ThreadForkService.ThreadForkServiceV2.pipe(
        Effect.flatMap((forks) =>
          forks.plan({
            sourceProjection: { thread },
            sourceRun: { id: RunId.make("run:source"), status: "completed" } as OrchestrationV2Run,
            sourceProviderThread: undefined,
            canonicalSourcePoint: { threadId: laptops },
            transferId: ContextTransferId.make("transfer:taken-over-fork"),
            targetThreadId: ThreadId.make("thread:taken-over-fork"),
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: thread.createdAt,
          }),
        ),
        Effect.provide(ThreadForkService.layer),
      );
      assert.equal(fork.targetThread.linkFenceRelease, undefined);
      assert.equal(fork.targetThread.linkOrigin?.sessionId, "laptop");
    }),
  );
});

// A link's launch names the thread there that launched it, for display only.
it.layer(Layer.provideMerge(layerTools, layerOrchestration))("a thread a link launched", (it) => {
  const laptopParent = {
    environmentId: "environment-laptop",
    threadId: "thread-laptop-parent",
    title: "Laptop parent",
  };
  const launchedFromOf = (threadId: ThreadId) =>
    ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) => projections.getThreadShell(threadId)),
      Effect.map((shell) => shell?.launchedFrom),
    );

  it.effect("keeps the thread there only when the link itself sends it, cleaned", () =>
    Effect.gen(function* () {
      const launched = yield* launch(laptop, "Launched from the laptop", {
        launchedFrom: {
          ...laptopParent,
          title: `  Fix\u202E the\n\tbuild\u0007 ${"x".repeat(300)}`,
        },
      });
      const launchedFrom = yield* launchedFromOf(launched);
      assert.equal(launchedFrom?.environmentId, "environment-laptop");
      assert.equal(launchedFrom?.threadId, "thread-laptop-parent");
      assert.isTrue(launchedFrom?.title.startsWith("Fix the build xxx"));
      assert.equal(Array.from(launchedFrom?.title ?? "").length, 120);
      assert.isTrue(launchedFrom?.title.endsWith("\u2026"));

      // An older environment sends none, and the thread is the link's as before.
      const older = yield* launch(laptop, "From an older laptop");
      assert.equal(yield* launchedFromOf(older), undefined);
      assert.equal(
        (yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.flatMap((projections) => projections.getThreadShell(older)),
        ))?.linkOrigin?.sessionId,
        "laptop",
      );

      // Ids that could not go into a thread link are dropped, not stored.
      for (const bad of [
        { ...laptopParent, threadId: "thread/../../etc" },
        { ...laptopParent, environmentId: "env laptop" },
        { ...laptopParent, threadId: "t".repeat(300) },
      ]) {
        const dropped = yield* launch(laptop, "Odd ids", { launchedFrom: bad });
        assert.equal(yield* launchedFromOf(dropped), undefined);
      }

      // Not a link: an outside agent cannot claim a thread there.
      const plain = yield* launch(claudeCode, "Claims a source", { launchedFrom: laptopParent });
      assert.equal(yield* launchedFromOf(plain), undefined);

      // Nor can an agent in the link's thread here: only the link says which thread there.
      const agentHere = {
        ...laptop,
        thread: {
          threadId: launched,
          providerSessionId: "session:provider",
          providerInstanceId: instanceId,
        },
      };
      const laptopOrigin = {
        sessionId: "laptop",
        label: "T3 Code · laptop",
        access: "auto" as const,
      };
      const sent = {
        environmentId: EnvironmentId.make("environment-laptop"),
        threadId: ThreadId.make("thread-laptop-parent"),
        title: "Laptop parent",
      };
      assert.deepEqual(launchSourceFromLink(laptop, laptopOrigin, sent), { launchedFrom: sent });
      assert.deepEqual(launchSourceFromLink(agentHere, laptopOrigin, sent), {});
      assert.deepEqual(
        launchSourceFromLink({ ...agentHere, client: undefined }, laptopOrigin, sent),
        {},
      );
      assert.deepEqual(launchSourceFromLink(claudeCode, undefined, sent), {});
      assert.deepEqual(launchSourceFromLink(desk, laptopOrigin, sent), {});
      assert.deepEqual(launchSourceFromLink(laptop, laptopOrigin, undefined), {});
    }),
  );

  it.effect("changes no fence, no takeover, and no link's reach", () =>
    Effect.gen(function* () {
      yield* setTakeover(true);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      // A link naming a thread the user owns here, or another link's, gains nothing by it.
      const deskLaunch = yield* launch(desk, "The desk's");
      const claims = yield* launch(laptop, "Claims to come from here", {
        launchedFrom: { environmentId: "environment:box", threadId: users, title: "Users" },
      });
      const claimsDesk = yield* launch(laptop, "Claims the desk's", {
        launchedFrom: { environmentId: "environment:box", threadId: deskLaunch, title: "Desk" },
      });
      for (const threadId of [claims, claimsDesk]) {
        assert.equal(
          (yield* projections.getThreadShell(threadId))?.linkOrigin?.sessionId,
          "laptop",
        );
        assert.isTrue(yield* fenced(threadId));
      }
      for (const target of [users, deskLaunch]) {
        const renamed = yield* call(laptop, "t3_thread_update", {
          threadId: target,
          action: "rename",
          title: "Renamed by the laptop",
        });
        assert.equal(failureCode(renamed), "capability_denied");
      }
      // The desk still may not change the laptop's thread that names the desk's.
      assert.equal(
        failureCode(
          yield* call(desk, "t3_thread_update", {
            threadId: claimsDesk,
            action: "rename",
            title: "Renamed by the desk",
          }),
        ),
        "capability_denied",
      );

      // A takeover works as it did, and the source stays only for display.
      const launched = yield* launch(laptop, "Taken over", { launchedFrom: laptopParent });
      assert.isTrue(yield* fenced(launched));
      yield* messageFromUser(launched, "launched-from-takeover");
      assert.isDefined(yield* releaseOf(launched));
      assert.isFalse(yield* fenced(launched));
      assert.deepEqual(yield* launchedFromOf(launched), laptopParent);
    }),
  );

  it.effect("is not carried into forks or subagents here", () =>
    Effect.gen(function* () {
      const launched = yield* launch(laptop, "Forked here", { launchedFrom: laptopParent });
      const thread = (yield* ThreadManagement.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadProjection(launched)),
      )).thread;
      assert.deepEqual(thread.launchedFrom, laptopParent);
      const child = makeSubagentChildThread({
        parentThread: thread,
        childThreadId: ThreadId.make("thread:launched-child"),
        parentNodeId: NodeId.make("node:launched-child"),
        activeProviderThreadId: null,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        title: "Child",
        now: thread.createdAt,
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(child.launchedFrom, undefined);
      assert.deepEqual(child.linkOrigin, thread.linkOrigin);
      const fork = yield* ThreadForkService.ThreadForkServiceV2.pipe(
        Effect.flatMap((forks) =>
          forks.plan({
            sourceProjection: { thread },
            sourceRun: { id: RunId.make("run:source"), status: "completed" } as OrchestrationV2Run,
            sourceProviderThread: undefined,
            canonicalSourcePoint: { threadId: launched },
            transferId: ContextTransferId.make("transfer:launched-fork"),
            targetThreadId: ThreadId.make("thread:launched-fork"),
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: thread.createdAt,
          }),
        ),
        Effect.provide(ThreadForkService.layer),
      );
      assert.equal(fork.targetThread.launchedFrom, undefined);
      assert.deepEqual(fork.targetThread.linkOrigin, thread.linkOrigin);
    }),
  );
});
