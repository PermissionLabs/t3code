import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironment } from "~/state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadEnvironmentBadge({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const label = environment?.label || environmentId;
  const description = `Runs on ${label} · ${environment?.connection.phase ?? "unknown"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
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
