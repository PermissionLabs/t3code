import { CommandId, type OrchestrationV2Command, threadLinkFence } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Security: only the WebSocket path runs this. `/mcp` sessions, links among them, are refused
 * there (`rejectMcpClientAudience`), and agents' sends go through `sendToThread`, never here.
 */

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * A message the person typed: one the client sent as the user, not a guest's message it passes
 * on, nor a notice, schedule, continuation, or another thread's message it relays.
 */
export const isUserAuthoredMessage = (
  command: OrchestrationV2Command,
): command is MessageDispatch =>
  command.type === "message.dispatch" &&
  command.createdBy === "user" &&
  command.guestMessageId === undefined &&
  command.notification === undefined &&
  command.senderThreadId === undefined &&
  command.scheduledTaskId === undefined &&
  command.idleCompaction === undefined &&
  command.delegatedCompletion === undefined &&
  command.restartContinuationOfRunId === undefined &&
  command.usageLimitContinuationOfRunId === undefined &&
  command.manualContinuationOfRunId === undefined &&
  command.usageLimitRecoveryRequestId === undefined;

export const releaseCommandId = (messageCommandId: string) =>
  CommandId.make(`link-fence-release:${messageCommandId}`);

/**
 * Lifts the link fence on the thread `command` messages, when the setting is on and the thread is
 * still fenced. Runs before the message is dispatched, so the run it starts is already this
 * environment's. Never fails the message: a failure is logged and the thread stays fenced.
 */
const releaseOnUserMessage = Effect.fn("LinkFenceTakeover.releaseOnUserMessage")(
  function* (command: OrchestrationV2Command, session: { readonly sessionId: string }) {
    if (!isUserAuthoredMessage(command)) return false;
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.releaseLinkFenceOnUserTakeover),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return false;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const thread = yield* threads.getThreadShell(command.threadId);
    if (thread === null || thread.deletedAt !== null) return false;
    const fence = threadLinkFence(thread);
    if (fence === undefined) return false;
    yield* threads.dispatch({
      type: "thread.link-fence.release",
      commandId: releaseCommandId(command.commandId),
      threadId: command.threadId,
      releasedBy: { kind: "local-user", sessionId: session.sessionId },
    });
    yield* Effect.logInfo(
      "A person here took over a thread a link started; its fence is lifted.",
    ).pipe(
      Effect.annotateLogs({
        threadId: command.threadId,
        linkSessionId: fence.sessionId,
        linkLabel: fence.label,
        releasedBySessionId: session.sessionId,
      }),
    );
    return true;
  },
  (effect) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not lift a link fence on a user's message.", cause).pipe(
          Effect.as(false),
        ),
      ),
    ),
);

/**
 * A command from one of this environment's own signed-in clients over the WebSocket, as the user.
 * The only caller is that path in `ws.ts`, which `/mcp` sessions (links among them) never reach.
 */
export const dispatchFromUserClient = Effect.fn("LinkFenceTakeover.dispatchFromUserClient")(
  function* (command: OrchestrationV2Command, session: { readonly sessionId: string }) {
    const stamped = ThreadManagement.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "creationSource" in command ? command.creationSource : "web",
    });
    yield* releaseOnUserMessage(stamped, session);
    return yield* ThreadMessageIntake.dispatchCommand(stamped);
  },
);
