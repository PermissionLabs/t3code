import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export class ServerUpdatingError extends Schema.TaggedError<ServerUpdatingError>()(
  "ServerUpdatingError",
  {},
) {
  override get message(): string {
    return "This server is restarting for an update. Try again in a minute.";
  }
}

interface GateState {
  readonly closed: boolean;
  readonly inflight: number;
  readonly drained: Deferred.Deferred<void> | undefined;
}

/**
 * Work that would start a turn or a terminal passes through `admit`. An update closes the gate,
 * waits for admitted work to commit, and only then checks idleness, so nothing can start between
 * that check and the launcher handoff.
 */
export class UpdateGate extends Context.Reference<{
  readonly admit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServerUpdatingError, R>;
  readonly close: Effect.Effect<void>;
  readonly reopen: Effect.Effect<void>;
}>("t3/cloud/updateGate/UpdateGate", {
  defaultValue: () => ({
    admit: (effect) => effect,
    close: Effect.void,
    reopen: Effect.void,
  }),
}) {}

export const make = Effect.fn("UpdateGate.make")(function* () {
  const state = yield* Ref.make<GateState>({ closed: false, inflight: 0, drained: undefined });

  const leave = Ref.modify(state, (current): [Deferred.Deferred<void> | undefined, GateState] => {
    const inflight = current.inflight - 1;
    return inflight === 0 && current.drained !== undefined
      ? [current.drained, { ...current, inflight, drained: undefined }]
      : [undefined, { ...current, inflight }];
  }).pipe(
    Effect.flatMap((drained) => (drained ? Deferred.succeed(drained, undefined) : Effect.void)),
  );

  const admit = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ServerUpdatingError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Ref.modify(state, (current): [boolean, GateState] =>
        current.closed ? [false, current] : [true, { ...current, inflight: current.inflight + 1 }],
      ).pipe(
        Effect.flatMap((admitted): Effect.Effect<A, E | ServerUpdatingError, R> =>
          admitted
            ? restore(effect).pipe(Effect.ensuring(leave))
            : Effect.fail(new ServerUpdatingError()),
        ),
      ),
    );

  const close = Effect.gen(function* () {
    const drained = yield* Deferred.make<void>();
    const wait = yield* Ref.modify(state, (current): [boolean, GateState] =>
      current.inflight === 0
        ? [false, { ...current, closed: true }]
        : [true, { ...current, closed: true, drained }],
    );
    if (wait) yield* Deferred.await(drained);
  });

  const reopen = Ref.update(state, (current) => ({
    ...current,
    closed: false,
    drained: undefined,
  }));

  return UpdateGate.of({ admit, close, reopen });
});

export const layer = Layer.effect(UpdateGate, make());
