import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("unsets inherited names and prefixes so a merging spawn still drops them", () =>
    Effect.gen(function* () {
      const baseEnv = {
        SSH_AUTH_SOCK: "/agent.sock",
        OP_SESSION_x: "session",
        OP_ACCOUNT: "acct",
        OPENAI_API_KEY: "kept",
        PATH: "/bin",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "GIT_ASKPASS", value: "", sensitive: false, unset: "exact" },
          { name: "SSH_AUTH_SOCK", value: "", sensitive: false, unset: "exact" },
          { name: "OP_", value: "", sensitive: false, unset: "prefix" },
          // A later value wins over an earlier unset.
          { name: "OP_ACCOUNT", value: "agent", sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        GIT_ASKPASS: undefined,
        SSH_AUTH_SOCK: undefined,
        OP_SESSION_x: undefined,
        OP_ACCOUNT: "agent",
        OPENAI_API_KEY: "kept",
        PATH: "/bin",
      });
      // The names stay as keys: `extendEnv: true` deletes a key whose value is undefined.
      expect(Object.keys(environment)).toContain("SSH_AUTH_SOCK");
      expect(baseEnv.SSH_AUTH_SOCK).toBe("/agent.sock");
      // An earlier value loses to a later unset.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "GIT_SSH_COMMAND", value: "ssh -i key", sensitive: false },
            { name: "GIT_SSH_COMMAND", value: "", sensitive: false, unset: "exact" },
          ],
          {},
        ),
      ).toEqual({ GIT_SSH_COMMAND: undefined });
      // Windows matches every spelling and keeps it, since a merge deletes by exact key.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "SSH_AUTH_SOCK", value: "", sensitive: false, unset: "exact" },
            { name: "op_", value: "", sensitive: false, unset: "prefix" },
          ],
          { Ssh_Auth_Sock: "/agent.sock", Op_Token: "t", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, "win32")),
      ).toEqual({
        Ssh_Auth_Sock: undefined,
        SSH_AUTH_SOCK: undefined,
        Op_Token: undefined,
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});
