import {
  linkOriginIsFenced,
  type OrchestrationV2LaunchedFrom,
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "./McpInvocationContext.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * Below full access, work a link starts here (all of it carries that session in `linkOrigin`)
 * may change only work from the same link: not the user's threads, projects or settings, nor
 * this environment's links. Reads are not fenced. A full-access link is not fenced at all.
 */

// A thread a person here took over (`linkFenceRelease`) is this environment's own: unfenced,
// and out of the starting link's reach.

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  // A takeover drops only what the thread carried: a linked client stays that link regardless.
  (caller.caller?.linkFenceRelease == null ? caller.caller?.linkOrigin : undefined) ??
  linkedClientOrigin(caller);

const linkedClientOrigin = (
  caller: Pick<Caller, "scope">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.scope.client?.linked === true
    ? {
        sessionId: caller.scope.client.sessionId,
        label: caller.scope.client.label,
        access: caller.scope.client.access,
      }
    : undefined;

/** The link that fences a caller, if any: one paired below full access. */
const fencingLinkOrigin = (caller: Pick<Caller, "scope" | "caller">) => {
  const origin = callerLinkOrigin(caller);
  return origin !== undefined && linkOriginIsFenced(origin) ? origin : undefined;
};

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message} A link paired with full access is not limited this way.`,
  });

/** A thread a fenced caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin" | "linkFenceRelease">,
) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined ||
    (target.linkOrigin?.sessionId === origin.sessionId && target.linkFenceRelease == null)
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Fenced work never changes what the environment already has: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};

/**
 * The thread in a linked environment that launched a thread here, as that link sent it. Only the
 * link itself says, never an agent here, even one in that link's own thread: the launch is
 * stamped with the link's origin and comes straight from its session. It is shown beside the
 * link's label and never trusted; the orchestrator cleans it as it stores it.
 */
export const launchSourceFromLink = (
  scope: Pick<McpInvocationContext.McpInvocationScope, "thread" | "client">,
  linkOrigin: OrchestrationV2LinkOrigin | undefined,
  launchedFrom: OrchestrationV2LaunchedFrom | undefined,
): { readonly launchedFrom?: OrchestrationV2LaunchedFrom } =>
  linkOrigin === undefined ||
  launchedFrom === undefined ||
  scope.thread !== undefined ||
  scope.client?.linked !== true ||
  scope.client.sessionId !== linkOrigin.sessionId
    ? {}
    : { launchedFrom };
