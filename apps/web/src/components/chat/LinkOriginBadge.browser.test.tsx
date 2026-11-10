import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { LinkOriginBadge } from "./LinkOriginBadge";

it("shows only the machine when the linked environment named no thread", async () => {
  await using screen = await render(<LinkOriginBadge origin={{ label: "mini-1", source: null }} />);
  await expect.element(screen.getByText("From mini-1")).toBeInTheDocument();
  await expect.element(screen.getByTestId("link-origin-source-title")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /mini-1/ })).not.toBeInTheDocument();
});

it("names the thread there, and opens it when this client is connected to that machine", async () => {
  let opened = 0;
  await using screen = await render(
    <LinkOriginBadge
      origin={{
        label: "mini-1",
        source: {
          title: "Plan the release",
          link: "t3-thread://v2/env-mini-1/thread-parent",
          relation: "launched",
          open: () => {
            opened += 1;
          },
        },
      }}
    />,
  );
  await expect
    .element(screen.getByTestId("link-origin-source-title"))
    .toHaveTextContent("Plan the release");
  await screen.getByRole("button", { name: "Open Plan the release on mini-1" }).click();
  expect(opened).toBe(1);
});

it("names the thread there without opening it while that machine is not connected", async () => {
  await using screen = await render(
    <LinkOriginBadge
      origin={{
        label: "mini-1",
        source: {
          title: "Plan the release",
          link: "t3-thread://v2/env-mini-1/thread-parent",
          relation: "launched",
        },
      }}
    />,
  );
  await expect.element(screen.getByText("Plan the release")).toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Open Plan the release on mini-1" }))
    .not.toBeInTheDocument();
});
