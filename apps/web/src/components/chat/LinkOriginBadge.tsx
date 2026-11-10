import { memo } from "react";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A thread a linked environment started here, as its header badge shows it. */
export interface LinkOriginBadgeOrigin {
  /** The link's label: the other machine's name. */
  readonly label: string;
  /**
   * The thread there that started this one, when that environment said which. Display only:
   * the other machine wrote it.
   */
  readonly source: {
    readonly title: string;
    /** Its `t3-thread://v2/` link. */
    readonly link: string;
    readonly relation: "delegated" | "launched";
    /** Opens it; absent while this client is not connected to that environment. */
    readonly open?: (() => void) | undefined;
  } | null;
}

export const LinkOriginBadge = memo(function LinkOriginBadge(props: {
  readonly origin: LinkOriginBadgeOrigin;
  /** A person here took the linked thread over, so its agents are no longer limited to the link. */
  readonly fenceReleased?: boolean | undefined;
}) {
  const { label, source } = props.origin;
  const open = source?.open;
  const badge = (
    <Badge
      variant="info"
      size="sm"
      className="min-w-0 max-w-64 shrink"
      {...(open === undefined
        ? {}
        : {
            render: (
              <button
                type="button"
                aria-label={`Open ${source?.title ?? ""} on ${label}`}
                onClick={open}
              />
            ),
          })}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger render={badge}>
        <span className="shrink-0">From {label}</span>
        {source === null ? null : (
          <>
            <span aria-hidden className="shrink-0 opacity-60">
              ·
            </span>
            <span className="min-w-0 truncate" data-testid="link-origin-source-title">
              {source.title}
            </span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96">
        {source === null ? (
          <>Started by an agent on {label} through a linked environment.</>
        ) : (
          <>
            {source.relation === "delegated" ? "Delegated by " : "Launched by "}
            the agent in “{source.title}” on {label} through a linked environment.
            <span className="mt-1 block break-all font-mono text-2xs opacity-80">
              {source.link}
            </span>
            {open === undefined ? (
              <span className="mt-1 block">Connect to {label} to open it.</span>
            ) : (
              <span className="mt-1 block">Click to open it.</span>
            )}
          </>
        )}
        {props.fenceReleased ? (
          <span className="mt-1 block">
            You took it over, so its agents now work like this machine's own.
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
});
