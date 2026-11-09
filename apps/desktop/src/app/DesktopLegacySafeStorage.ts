import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  resolveMacSafeStorageKeys,
  type ChromiumKeyError,
} from "../preview/BrowserImport/ChromiumKeys.ts";
import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * `local-fork.sh start` runs the bare Electron binary, whose safeStorage key is
 * "Electron Safe Storage". The packaged fork names itself "T3 Code (Custom)" and
 * gets its own key, so it reads data the dev run wrote through this key once,
 * then re-encrypts it with its own.
 */
const LEGACY_SAFE_STORAGE_SERVICE = "Electron Safe Storage";
const LEGACY_SAFE_STORAGE_ACCOUNT = "Electron Key";

const CHROMIUM_MAC_PREFIX = "v10";

export const isChromiumMacCiphertext = (value: Uint8Array): boolean =>
  value.length > CHROMIUM_MAC_PREFIX.length &&
  Buffer.from(value.subarray(0, CHROMIUM_MAC_PREFIX.length)).toString("latin1") ===
    CHROMIUM_MAC_PREFIX;

export class DesktopLegacySafeStorage extends Context.Service<
  DesktopLegacySafeStorage,
  {
    /** Whether this app may read the dev-run key (packaged local fork on macOS). */
    readonly enabled: boolean;
    /**
     * Decrypts a value written with the dev-run key. None when migration does not
     * apply or the bytes do not decrypt under that key. Reading the key can show a
     * one-time Keychain prompt.
     */
    readonly decrypt: (value: Uint8Array) => Effect.Effect<Option.Option<string>, ChromiumKeyError>;
  }
>()("@t3tools/desktop/app/DesktopLegacySafeStorage") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const enabled = environment.platform === "darwin" && environment.isPackaged && config.localFork;

  return DesktopLegacySafeStorage.of({
    enabled,
    decrypt: Effect.fn("DesktopLegacySafeStorage.decrypt")(function* (value) {
      if (!enabled || !isChromiumMacCiphertext(value)) {
        return Option.none<string>();
      }
      const keys = yield* resolveMacSafeStorageKeys(
        LEGACY_SAFE_STORAGE_SERVICE,
        LEGACY_SAFE_STORAGE_ACCOUNT,
      );
      return Option.fromNullishOr(decryptChromiumValue(value, keys, "", 23, "darwin"));
    }),
  });
});

export const layer = Layer.effect(DesktopLegacySafeStorage, make);

/** For tests and platforms without a legacy key. */
export const layerDisabled = Layer.succeed(
  DesktopLegacySafeStorage,
  DesktopLegacySafeStorage.of({
    enabled: false,
    decrypt: Effect.fn("DesktopLegacySafeStorage.decryptDisabled")(function* () {
      return Option.none<string>();
    }),
  }),
);
