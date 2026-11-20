import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const forkRollout = {
  changes: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:fork-rollout:changes",
    tag: WS_METHODS.serverForkRolloutSubscribe,
  }),
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-rollout:start",
    tag: WS_METHODS.serverForkRolloutStart,
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-rollout:cancel",
    tag: WS_METHODS.serverForkRolloutCancel,
  }),
};
