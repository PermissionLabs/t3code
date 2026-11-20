import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ForkRollout as ForkRolloutState,
  OrchestratorMcpFailure,
  type ServerSelfUpdateOutcome,
  type ServerUpdateJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
const BASE_DIR = "/t3-home";
const STATE_PATH = `${BASE_DIR}/fork-rollout.json`;

interface Status {
  readonly serverVersion: string;
  readonly job: ServerUpdateJob;
  readonly lastUpdate?: ServerSelfUpdateOutcome;
}
const unreachable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "connect ECONNREFUSED",
});
const idle = (serverVersion = "0.1.8"): Status => ({ serverVersion, job: { status: "idle" } });
const waiting: Status = {
  serverVersion: "0.1.8",
  job: { status: "running", targetVersion: TARGET, stage: "waiting-for-idle" },
};

const isFailure = Schema.is(OrchestratorMcpFailure);

/** Status replies per peer, in order; the last one repeats. Start and cancel only log. */
type PeerScript = ReadonlyArray<Status | OrchestratorMcpFailure>;

const makeService = Effect.fn("test.make_fork_rollout")(function* (input: {
  readonly files: Map<string, string>;
  readonly peers: Partial<Record<string, PeerScript>>;
  readonly calls: Array<string>;
}) {
  const served = new Map<string, number>();
  const peerClient = PeerMcpClient.PeerMcpClient.of({
    call: (request) =>
      Effect.suspend(() => {
        const action = String(request.arguments.action);
        input.calls.push(`${request.environmentId}:${action}`);
        const script = input.peers[request.environmentId] ?? [];
        const index = served.get(request.environmentId) ?? 0;
        if (action === "status") served.set(request.environmentId, index + 1);
        const reply = script[Math.min(index, script.length - 1)] ?? idle();
        return isFailure(reply) ? Effect.fail(reply) : Effect.succeed(reply);
      }) as never,
  });
  // In memory, so the driver only suspends on its poll sleep and one clock adjust runs it.
  const files = FileSystem.layerNoop({
    readFileString: (path) =>
      Effect.suspend(() => {
        const content = input.files.get(path);
        return content === undefined
          ? Effect.fail(new Error("missing") as never)
          : Effect.succeed(content);
      }),
    writeFileString: (path, content) => Effect.sync(() => void input.files.set(path, content)),
    rename: (from, to) =>
      Effect.sync(() => {
        input.files.set(to, input.files.get(from)!);
        input.files.delete(from);
      }),
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-rollout-test-" })),
  );
  return yield* ForkRollout.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer({ ...config, baseDir: BASE_DIR }),
        files,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: SELF, label: "mini-1" } as never),
        }),
        Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({
          job: Effect.succeed({ status: "idle" } as const),
          startJob: () => Effect.die("self is already on the target in these tests"),
          cancelJob: () => Effect.void,
        }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          snapshot: Effect.succeed({
            sequence: 1,
            events: [{ type: "ready", sequence: 1, payload: {} } as never],
          }),
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

const settled = (service: ForkRollout.ForkRolloutService["Service"]) =>
  service.changes.pipe(
    Stream.filter(
      (rollout): rollout is ForkRolloutState => rollout !== null && rollout.status !== "running",
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkChild,
  );

it.layer(NodeServices.layer)("fork rollout", (it) => {
  it("decides a step from the target's version, launcher outcome, and job", () => {
    const rolledBack: ServerSelfUpdateOutcome = {
      id: "u1",
      fromVersion: "0.1.8",
      targetVersion: TARGET,
      status: "rolled-back",
      reason: "candidate-exited:1",
    };
    const failed: Status = {
      serverVersion: "0.1.8",
      job: { status: "failed", targetVersion: TARGET, reason: "disk full" },
    };
    const fresh = { started: false };
    expect(ForkRollout.evaluateUpdateStep(TARGET, idle(TARGET), fresh)).toEqual({ ok: true });
    expect(
      ForkRollout.evaluateUpdateStep(TARGET, { ...idle(), lastUpdate: rolledBack }, fresh),
    ).toEqual({
      ok: false,
      detail: "Restarted on t3@0.1.8 after the update rolled-back (candidate-exited:1).",
    });
    // An earlier attempt's outcome and job do not fail a new step.
    expect(
      ForkRollout.evaluateUpdateStep(
        TARGET,
        { ...idle(), lastUpdate: rolledBack },
        { ignoreUpdateId: "u1", started: false },
      ),
    ).toBeUndefined();
    expect(ForkRollout.evaluateUpdateStep(TARGET, failed, fresh)).toBeUndefined();
    expect(ForkRollout.evaluateUpdateStep(TARGET, failed, { started: true })).toEqual({
      ok: false,
      detail: "disk full",
    });
    expect(ForkRollout.evaluateUpdateStep(TARGET, waiting, { started: true })).toBeUndefined();
  });

  it.effect("updates servers in order and stops at the first failure", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<string> = [];
      const service = yield* makeService({
        files,
        calls,
        peers: {
          [MINI_2]: [idle(), waiting, idle(TARGET)],
          [MACBOOK]: [
            idle(),
            {
              serverVersion: "0.1.8",
              job: { status: "failed", targetVersion: TARGET, reason: "disk full" },
            },
          ],
        },
      });
      const done = yield* settled(service);
      yield* service.start({ version: TARGET, environmentIds: [MINI_2, MACBOOK, SELF] });
      yield* TestClock.adjust("10 minutes");
      const rollout = yield* Fiber.join(done);

      expect(rollout.status).toBe("failed");
      expect(rollout.targets.map(({ status }) => status)).toEqual(["done", "failed", "pending"]);
      expect(rollout.targets[1]?.detail).toBe("disk full");
      expect(calls).toEqual([
        `${MINI_2}:status`,
        `${MINI_2}:start`,
        `${MINI_2}:status`,
        `${MINI_2}:status`,
        `${MACBOOK}:status`,
        `${MACBOOK}:start`,
        `${MACBOOK}:status`,
      ]);
      expect(JSON.parse(files.get(STATE_PATH)!)).toMatchObject({
        status: "failed",
        version: TARGET,
      });
    }),
  );

  it.effect("keeps going through a peer restart and an earlier attempt's rollback", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<string> = [];
      const staleRollback: ServerSelfUpdateOutcome = {
        id: "earlier",
        fromVersion: "0.1.8",
        targetVersion: TARGET,
        status: "rolled-back",
      };
      const service = yield* makeService({
        files,
        calls,
        peers: {
          // Unreachable at first, as while its launcher swaps runtimes, then back on the target.
          [MINI_2]: [unreachable, unreachable, idle(TARGET)],
          [MACBOOK]: [
            { ...idle(), lastUpdate: staleRollback },
            { ...waiting, lastUpdate: staleRollback },
            idle(TARGET),
          ],
        },
      });
      const done = yield* settled(service);
      yield* service.start({ version: TARGET, environmentIds: [MINI_2, MACBOOK] });
      yield* TestClock.adjust("10 minutes");
      const rollout = yield* Fiber.join(done);

      expect(rollout.status).toBe("succeeded");
      expect(calls.filter((call) => call.endsWith(":start"))).toEqual([`${MACBOOK}:start`]);
    }),
  );

  it.effect("resumes a stored rollout after this server restarts on the target", () =>
    Effect.gen(function* () {
      const running: ForkRolloutState = {
        id: "rollout-1",
        version: packageJson.version,
        status: "running",
        targets: [
          { environmentId: SELF, label: "mini-1", status: "updating", started: true },
          { environmentId: MINI_2, label: "mini-2", status: "pending" },
        ],
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
      };
      const files = new Map([[STATE_PATH, JSON.stringify(running)]]);
      const calls: Array<string> = [];
      const service = yield* makeService({
        files,
        calls,
        peers: { [MINI_2]: [idle(packageJson.version)] },
      });
      const rollout = yield* Fiber.join(yield* settled(service));
      expect(rollout.status).toBe("succeeded");
      expect(rollout.targets.map(({ status }) => status)).toEqual(["done", "done"]);
      expect(calls).toEqual([`${MINI_2}:status`]);
    }),
  );

  it.effect("reports a cancel that could not reach the updating server", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const service = yield* makeService({
        files: new Map(),
        calls,
        peers: { [MINI_2]: [idle(), unreachable] },
      });
      yield* service.start({ version: TARGET, environmentIds: [MINI_2] });
      yield* TestClock.adjust(ForkRollout.POLL_INTERVAL);
      const cancelled = yield* service.cancel;
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.targets[0]?.detail).toContain("may still restart");
      expect(calls.at(-1)).toBe(`${MINI_2}:cancel`);
    }),
  );

  it.effect("refuses inexact versions and repeated servers", () =>
    Effect.gen(function* () {
      const service = yield* makeService({ files: new Map(), calls: [], peers: {} });
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
