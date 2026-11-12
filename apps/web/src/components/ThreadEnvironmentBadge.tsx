import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironment } from "~/state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadEnvironmentBadge({
  environmentId,
  focusable = false,
}: {
  environmentId: EnvironmentId;
  focusable?: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const label = environment?.label || "Unknown machine";
  const status = environment ? connectionStatusTitle(environment.connection) : "Connection unknown";
  const description = `Runs on ${label} · ${status}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={focusable ? 0 : undefined}
            aria-label={description}
            className="inline-flex max-w-24 shrink-0 items-center rounded border border-border px-1 text-3xs font-normal text-muted-foreground"
          />
        }
      >
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
