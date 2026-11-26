import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

/** The keys of `env` an unset entry removes, matching names without regard to case on Windows. */
export function providerInstanceUnsetNames(
  variable: { readonly name: string; readonly unset?: "exact" | "prefix" | undefined },
  env: NodeJS.ProcessEnv,
  windows: boolean,
): ReadonlyArray<string> {
  const target = windows ? variable.name.toUpperCase() : variable.name;
  return Object.keys(env).filter((inherited) => {
    const key = windows ? inherited.toUpperCase() : inherited;
    return variable.unset === "prefix" ? key.startsWith(target) : key === target;
  });
}

/**
 * Applies the instance's variables over `baseEnv`, in order. An unset entry keeps each name it
 * removes in the result with the value `undefined`: Node's spawn skips such a name, and a spawn
 * that merges the parent environment back in (`extendEnv: true`) deletes it.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    if (variable.unset !== undefined) {
      const removed = new Set([
        ...providerInstanceUnsetNames(variable, next, windows),
        // Keep the inherited spellings: a merge back into the parent environment deletes by key.
        ...providerInstanceUnsetNames(variable, baseEnv, windows),
        ...(variable.unset === "exact" ? [variable.name] : []),
      ]);
      for (const name of removed) {
        delete next[name];
        next[name] = undefined;
      }
      continue;
    }
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});
