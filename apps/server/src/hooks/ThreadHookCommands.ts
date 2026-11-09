import type { ThreadHook, ThreadHookEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What every hook payload carries: the event, and the id a hook that must not act twice keys on. */
export interface ThreadHookPayloadBase {
  readonly version: 1;
  readonly event: ThreadHookEvent;
  readonly eventId: string;
}

/** Runs the `threadHooks` that list an event, one at a time, with the event's JSON on stdin. */
export class ThreadHookCommands extends Context.Service<
  ThreadHookCommands,
  {
    /** Failures and timeouts are logged, never raised. */
    readonly run: (payload: ThreadHookPayloadBase) => Effect.Effect<void>;
  }
>()("t3/hooks/ThreadHookCommands") {}

export const makeCommands = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const windows = (yield* HostProcess.Platform) === "win32";
  const environment = yield* HostProcess.Environment;

  const runHook = (hook: ThreadHook, payload: ThreadHookPayloadBase) =>
    runner
      .run({
        command: windows ? "cmd.exe" : "/bin/sh",
        args: windows ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command],
        stdin: `${encodeJson(payload)}\n`,
        env: { ...environment, T3CODE_HOOK_EVENT: payload.event },
        timeout: `${hook.timeoutMs ?? DEFAULT_TIMEOUT_MS} millis`,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.timedOut || result.code !== 0
            ? Effect.logWarning("a thread hook failed", {
                event: payload.event,
                eventId: payload.eventId,
                command: hook.command,
                exitCode: result.code,
                timedOut: result.timedOut,
                stderr: result.stderr.slice(-2_000),
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("a thread hook could not run", { command: hook.command, cause }),
        ),
      );

  const run: ThreadHookCommands["Service"]["run"] = Effect.fnUntraced(function* (payload) {
    const hooks = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined)))
      ?.threadHooks;
    for (const hook of hooks ?? []) {
      if (hook.events.includes(payload.event)) yield* runHook(hook, payload);
    }
  });

  return ThreadHookCommands.of({ run });
});

export const layer = Layer.effect(ThreadHookCommands, makeCommands);
