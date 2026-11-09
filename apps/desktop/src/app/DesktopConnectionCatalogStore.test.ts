// @effect-diagnostics nodeBuiltinImport:off - builds Chromium OSCrypt fixtures.
import * as NodeCrypto from "node:crypto";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { decryptChromiumValue } from "../preview/BrowserImport/ChromiumCookies.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacySafeStorage from "./DesktopLegacySafeStorage.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

const LEGACY_SECRET = "dev-run-electron-secret";
const deriveLegacyKey = (secret: string) =>
  NodeCrypto.pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");

/** Chromium OSCrypt on macOS: "v10" + AES-128-CBC, PBKDF2-SHA1 key, IV of 16 spaces. */
function encryptLikeDevRun(plaintext: string, secret = LEGACY_SECRET): Uint8Array {
  const cipher = NodeCrypto.createCipheriv(
    "aes-128-cbc",
    deriveLegacyKey(secret),
    Buffer.alloc(16, 0x20),
  );
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext, "utf8"), cipher.final()]);
}

/** The real decrypt path, with the Keychain read replaced by a fixed secret. */
function layerLegacySafeStorageFor(enabled: boolean, keychain: Ref.Ref<number> | null = null) {
  return Layer.succeed(
    DesktopLegacySafeStorage.DesktopLegacySafeStorage,
    DesktopLegacySafeStorage.DesktopLegacySafeStorage.of({
      enabled,
      decrypt: (value) =>
        Effect.gen(function* () {
          if (!enabled || !DesktopLegacySafeStorage.isChromiumMacCiphertext(value)) {
            return Option.none<string>();
          }
          if (keychain !== null) yield* Ref.update(keychain, (count) => count + 1);
          return Option.fromNullishOr(
            decryptChromiumValue(
              value,
              { cbcV10: deriveLegacyKey(LEGACY_SECRET) },
              "",
              23,
              "darwin",
            ),
          );
        }),
    }),
  );
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  legacyLayer: Layer.Layer<DesktopLegacySafeStorage.DesktopLegacySafeStorage> = DesktopLegacySafeStorage.layerDisabled,
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const layerSafeStorage = layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    legacyLayer,
    NodeServices.layer,
    EffectNodeCrypto.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists and reads an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = layerFor(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  describe("dev-run safe storage key migration", () => {
    const catalog = '{"schemaVersion":1,"targets":[{"label":"devbox"}]}';

    const withLegacyStore = <A, E, R>(
      enabled: boolean,
      body: (input: {
        readonly catalogPath: string;
        readonly stateDir: string;
        readonly keychainReads: Ref.Ref<number>;
      }) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const keychainReads = yield* Ref.make(0);
        const stateDir = path.join(baseDir, "userdata");
        const catalogPath = path.join(stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(stateDir, { recursive: true });
        return yield* body({ catalogPath, stateDir, keychainReads }).pipe(
          Effect.provide(
            layerFor(
              baseDir,
              true,
              null,
              NodeServices.layer,
              layerLegacySafeStorageFor(enabled, keychainReads),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

    const writeDevRunCatalog = (catalogPath: string, value: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const document = JSON.stringify({
          version: 1,
          encryptedCatalog: Base64.encode(encryptLikeDevRun(value)),
        });
        yield* fileSystem.writeFileString(catalogPath, document);
        return document;
      });

    it.effect("re-encrypts a dev-run catalog once and keeps the original as a backup", () =>
      withLegacyStore(true, ({ catalogPath, stateDir, keychainReads }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const original = yield* writeDevRunCatalog(catalogPath, catalog);

          const [first, second] = yield* Effect.all([store.get, store.get], {
            concurrency: "unbounded",
          });
          assert.deepStrictEqual(first, Option.some(catalog));
          assert.deepStrictEqual(second, Option.some(catalog));
          assert.deepStrictEqual(yield* store.get, Option.some(catalog));
          assert.equal(yield* Ref.get(keychainReads), 1);

          const rewritten = JSON.parse(yield* fileSystem.readFileString(catalogPath));
          assert.equal(
            textDecoder.decode(yield* Effect.fromResult(Base64.decode(rewritten.encryptedCatalog))),
            `encrypted:${catalog}`,
          );
          const backups = (yield* fileSystem.readDirectory(stateDir)).filter((name) =>
            name.startsWith("connection-catalog.json.bak-"),
          );
          assert.lengthOf(backups, 1);
          assert.equal(yield* fileSystem.readFileString(`${stateDir}/${backups[0]}`), original);
        }),
      ),
    );

    it.effect("leaves the catalog untouched when migration is not enabled", () =>
      withLegacyStore(false, ({ catalogPath, stateDir, keychainReads }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const original = yield* writeDevRunCatalog(catalogPath, catalog);

          const error = yield* store.get.pipe(Effect.flip);
          assert.instanceOf(
            error,
            DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
          );
          assert.equal(yield* Ref.get(keychainReads), 0);
          assert.equal(yield* fileSystem.readFileString(catalogPath), original);
          assert.deepStrictEqual(yield* fileSystem.readDirectory(stateDir), [
            "connection-catalog.json",
          ]);
        }),
      ),
    );

    it.effect("does not rewrite a catalog the dev-run key cannot decrypt", () =>
      withLegacyStore(true, ({ catalogPath, stateDir }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const document = JSON.stringify({
            version: 1,
            encryptedCatalog: Base64.encode(encryptLikeDevRun(catalog, "someone-else")),
          });
          yield* fileSystem.writeFileString(catalogPath, document);

          const error = yield* store.get.pipe(Effect.flip);
          assert.instanceOf(
            error,
            DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
          );
          assert.equal(yield* fileSystem.readFileString(catalogPath), document);
          assert.deepStrictEqual(yield* fileSystem.readDirectory(stateDir), [
            "connection-catalog.json",
          ]);
        }),
      ),
    );
  });
});
