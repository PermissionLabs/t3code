import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ForkServerRollout } from "./ForkServerRollout";

const mocks = vi.hoisted(() => ({
  updateServer: vi.fn(),
  environments: ["mini-2", "mini-1", "MacBook"].map((label) => ({
    environmentId: label,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        serverVersion: "0.1.8-fork.20261119+g4111f297b7",
        capabilities: { serverSelfUpdate: "boot-service", serverSelfUpdateIdleWait: true },
      },
    },
  })),
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("~/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const sessions = Atom.make([{}, {}, {}]);
  return { environmentSessionStatesAtom: () => sessions };
});
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const updates = Atom.make([]);
  return { environmentUpdateStatesAtom: () => updates };
});
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));
vi.mock("../ServerUpdateAction", () => ({
  canUpdateServer: () => true,
  serverUpdateStageLabel: (stage: string) => stage,
  useServerUpdate: () => mocks.updateServer,
}));

it("updates in selection order and stops after a failed restart", async () => {
  mocks.updateServer.mockReset();
  let completeCanary!: (result: { status: "updated" }) => void;
  mocks.updateServer
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeCanary = resolve;
        }),
    )
    .mockResolvedValueOnce({ status: "failed", message: "Server rolled back" });
  await using screen = await render(<ForkServerRollout />);
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Fork release version" }),
    "0.1.8-fork.20261120+g1234567890",
  );
  for (const label of ["mini-1", "mini-2", "MacBook"]) {
    await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
  }
  await userEvent.click(screen.getByRole("button", { name: "Deploy to selected servers" }));
  expect(mocks.updateServer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: "mini-1", waitForIdle: true }),
    { quiet: true },
  );
  completeCanary({ status: "updated" });
  await expect.element(screen.getByText("Server rolled back")).toBeVisible();
  expect(mocks.updateServer).toHaveBeenCalledTimes(2);
  expect(mocks.updateServer).toHaveBeenLastCalledWith(
    expect.objectContaining({ environmentId: "mini-2", waitForIdle: true }),
    { quiet: true },
  );
});
