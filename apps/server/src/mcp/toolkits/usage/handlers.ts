import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { buildProviderUsageReport } from "./report.ts";
import { UsageToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  provider_usage_limits: McpToolAccess.reads(({ providers, maxAgeSec }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const registry = yield* ProviderRegistry.ProviderRegistry;
      return {
        providers: buildProviderUsageReport({
          providers: yield* registry.getProviders,
          requested: providers,
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          maxAgeSec,
        }),
      };
    }),
  ),
});
