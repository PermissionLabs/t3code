import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ForkRollout as ForkRolloutState,
  OrchestratorMcpFailure,
  type ServerUpdateJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ForkRollout from "./forkRollout.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

const SELF = EnvironmentId.make("env-self");
const MINI_2 = EnvironmentId.make("env-mini-2");
const MACBOOK = EnvironmentId.make("env-macbook");
const TARGET = "9.9.9-fork.20261120000000+g0123456789abcdef0123456789abcdef01234567";

interface PeerScript {
  /** serverVersion and job after each call, in order; the last one repeats. */
  readonly replies: ReadonlyArray<{ serverVersion: string; job: ServerUpdateJob }>;
}

const makeService = Effect.fn("test.make_fork_rollout")(function* (input: {
  readonly baseDir: string;
  readonly peers: Partial<Record<string, PeerScript>>;
  readonly calls: Array<string>;
}) {
  const served = new Map<string, number>();
  const peerClient = PeerMcpClient.PeerMcpClient.of({
    call: (request) =>
      Effect.gen(function* () {
        const action = String(request.arguments.action);
        input.calls.push(`${request.environmentId}:${action}`);
        const script = input.peers[request.environmentId];
        if (script === undefined) {
          return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: "no peer" });
        }
        const index = served.get(request.environmentId) ?? 0;
        served.set(request.environmentId, index + 1);
        return script.replies[Math.min(index, script.replies.length - 1)]!;
      }) as never,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
  );
  return yield* ForkRollout.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer(config),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: SELF, label: "mini-1" } as never),
        }),
        Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({
          job: Effect.succeed({ status: "idle" } as const),
          startJob: () => Effect.die("self is already on the target in these tests"),
          cancelJob: Effect.void,
        }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
        }),
        Layer.succeed(PeerMcpClient.PeerMcpClient, peerClient),
        Layer.mock(PeerLinks.PeerLinks)({
          get: (environmentId) =>
            Effect.succeedSome({ environmentId, label: `label-${environmentId}` } as never),
        }),
        NodeCrypto.layer,
      ),
    ),
  );
});

const reaches = (
  service: ForkRollout.ForkRolloutService["Service"],
  reached: (rollout: ForkRolloutState) => boolean,
) =>
  service.changes.pipe(
    Stream.filter((rollout): rollout is ForkRolloutState => rollout !== null && reached(rollout)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const settled = (service: ForkRollout.ForkRolloutService["Service"]) =>
  reaches(service, (rollout) => rollout.status !== "running").pipe(Effect.forkChild);

/** Lets the poll for `index` fire once its step has started and is sleeping. */
const pollOnce = (service: ForkRollout.ForkRolloutService["Service"], index: number) =>
  reaches(service, (rollout) => rollout.targets[index]?.status === "updating").pipe(
    Effect.andThen(TestClock.adjust(ForkRollout.POLL_INTERVAL)),
  );

it.layer(NodeServices.layer)("fork rollout", (it) => {
  it("decides a step from the target's version, launcher outcome, and job", () => {
    const idle = { status: "idle" } as const;
    expect(ForkRollout.evaluateUpdateStep(TARGET, { serverVersion: TARGET, job: idle })).toEqual({
      ok: true,
    });
    expect(
      ForkRollout.evaluateUpdateStep(TARGET, {
        serverVersion: "0.1.8",
        job: idle,
        lastUpdate: {
          id: "u1",
          fromVersion: "0.1.8",
          targetVersion: TARGET,
          status: "rolled-back",
          reason: "candidate-exited:1",
        },
      }),
    ).toEqual({
      ok: false,
      detail: "Restarted on t3@0.1.8 after the update rolled-back (candidate-exited:1).",
    });
    expect(
      ForkRollout.evaluateUpdateStep(TARGET, {
        serverVersion: "0.1.8",
        job: { status: "failed", targetVersion: TARGET, reason: "disk full" },
      }),
    ).toEqual({ ok: false, detail: "disk full" });
    expect(
      ForkRollout.evaluateUpdateStep(TARGET, {
        serverVersion: "0.1.8",
        job: { status: "running", targetVersion: TARGET, stage: "waiting-for-idle" },
      }),
    ).toBeUndefined();
  });

  it.effect("updates servers in order and stops at the first failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-rollout-test-" });
      const calls: Array<string> = [];
      const service = yield* makeService({
        baseDir,
        calls,
        peers: {
          [MINI_2]: {
            replies: [
              { serverVersion: "0.1.8", job: { status: "idle" } },
              {
                serverVersion: "0.1.8",
                job: { status: "running", targetVersion: TARGET, stage: "waiting-for-idle" },
              },
              { serverVersion: TARGET, job: { status: "idle" } },
            ],
          },
          [MACBOOK]: {
            replies: [
              { serverVersion: "0.1.8", job: { status: "idle" } },
              {
                serverVersion: "0.1.8",
                job: { status: "failed", targetVersion: TARGET, reason: "disk full" },
              },
            ],
          },
        },
      });
      const done = yield* settled(service);
      yield* service.start({ version: TARGET, environmentIds: [MINI_2, MACBOOK, SELF] });
      yield* pollOnce(service, 0);
      yield* pollOnce(service, 1);
      const rollout = yield* Fiber.join(done);

      expect(rollout.status).toBe("failed");
      expect(rollout.targets.map(({ status }) => status)).toEqual(["done", "failed", "pending"]);
      expect(rollout.targets[1]?.detail).toBe("disk full");
      expect(calls).toEqual([
        `${MINI_2}:status`,
        `${MINI_2}:start`,
        `${MINI_2}:status`,
        `${MACBOOK}:status`,
        `${MACBOOK}:start`,
        `${MACBOOK}:status`,
      ]);
      const stored = yield* fs.readFileString(path.join(baseDir, "fork-rollout.json"));
      expect(JSON.parse(stored)).toMatchObject({ status: "failed", version: TARGET });
    }),
  );

  it.effect("resumes a stored rollout after this server restarts on the target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-rollout-test-" });
      const running: ForkRolloutState = {
        id: "rollout-1",
        version: packageJson.version,
        status: "running",
        targets: [
          { environmentId: SELF, label: "mini-1", status: "updating" },
          { environmentId: MINI_2, label: "mini-2", status: "pending" },
        ],
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
      };
      yield* fs.writeFileString(path.join(baseDir, "fork-rollout.json"), JSON.stringify(running));
      const calls: Array<string> = [];
      const service = yield* makeService({
        baseDir,
        calls,
        peers: {
          [MINI_2]: { replies: [{ serverVersion: packageJson.version, job: { status: "idle" } }] },
        },
      });
      const rollout = yield* Fiber.join(yield* settled(service));
      expect(rollout.status).toBe("succeeded");
      expect(rollout.targets.map(({ status }) => status)).toEqual(["done", "done"]);
      expect(calls).toEqual([`${MINI_2}:status`]);
    }),
  );

  it.effect("refuses inexact versions and repeated servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-rollout-test-" });
      const service = yield* makeService({ baseDir, calls: [], peers: {} });
      expect(
        (yield* service.start({ version: "latest", environmentIds: [SELF] }).pipe(Effect.flip))
          .reason,
      ).toContain("not an exact version");
      expect(
        (yield* service
          .start({ version: TARGET, environmentIds: [MINI_2, MINI_2] })
          .pipe(Effect.flip)).reason,
      ).toBe("Select each server once.");
    }),
  );
});
