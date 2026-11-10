import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

const LaunchParameters = Schema.Struct({
  title: Schema.String,
  launchedFrom: Schema.optional(Schema.Struct({ title: Schema.String })),
});
const decodeLaunch = Schema.decodeSync(LaunchParameters);

it("leaves out parameters only a linked environment sends", () => {
  const tool = Tool.make("launch", { parameters: LaunchParameters });
  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
  // Decoding still takes it from a linked environment.
  expect(decodeLaunch({ title: "T", launchedFrom: { title: "P" } })).toEqual({
    title: "T",
    launchedFrom: { title: "P" },
  });
});
