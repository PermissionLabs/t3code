import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import packageJson from "../../../../package.json" with { type: "json" };
import * as ServerSelfUpdate from "../../../cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "../../../serverLifecycleEvents.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_server_update: McpToolAccess.writes(
    ({ action, version }) =>
      Effect.gen(function* () {
        const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
        const target = version?.trim() ?? "";
        if (action !== "status") {
          const { client } = yield* McpInvocationContext.McpInvocationContext;
          // Restarting this server is maintenance; only a full-access link from the rollout's server may.
          if (
            client?.linked !== true ||
            McpInvocationContext.clientModeCeiling(client).runtimeMode !== "full-access"
          ) {
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "Updating this server needs a full-access link from the server running the rollout.",
            });
          }
          if (target === "") {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Pass the exact version.",
            });
          }
        }
        if (action === "start") {
          // A refused start (another version in progress) is final for the caller, not transient.
          yield* selfUpdate.startJob(target).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: error.reason,
                }),
            ),
          );
        } else if (action === "cancel") {
          yield* selfUpdate.cancelJob(target);
        }
        const { ready, updateOutcome: lastUpdate } = yield* ServerLifecycleEvents.startupState;
        return {
          serverVersion: packageJson.version,
          ready,
          job: yield* selfUpdate.job,
          ...(lastUpdate === undefined ? {} : { lastUpdate }),
        };
      }),
    { linkedCallers: "allowed" },
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
