import { OrchestratorMcpEnvironmentTarget, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DEFAULT_MAX_AGE_SEC, ProviderUsageReport, USAGE_REPORT_DRIVERS } from "./report.ts";

const ProviderUsageLimitsTool = Tool.make("provider_usage_limits", {
  description:
    "Cached provider subscription usage: remainingFraction (0-1) and resetsAt per window. Never probes. Missing or stale data is `unavailable` with a reason.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    providers: Schema.optional(
      Schema.Array(Schema.Literals(USAGE_REPORT_DRIVERS)).annotate({
        description: "Omit for all.",
      }),
    ),
    maxAgeSec: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 86_400 })).annotate({
        description: `Older data is stale. Default ${DEFAULT_MAX_AGE_SEC}.`,
      }),
    ),
  }),
  success: Schema.Struct({ providers: Schema.Array(ProviderUsageReport) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderRegistry.ProviderRegistry,
  ],
})
  .annotate(Tool.Title, "Provider usage limits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UsageToolkit = Toolkit.make(ProviderUsageLimitsTool);
