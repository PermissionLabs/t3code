import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

const RULE_FILENAMES = ["GEMINI.md", "AGENTS.md"] as const;
export const ANTIGRAVITY_RULE_FILE_MAX_BYTES = 24_000;
const ANTIGRAVITY_RULES_TOTAL_MAX_BYTES = 80_000;

function sliceUtf8Buffer(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

function truncateOnLineBoundary(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline > 0 ? text.slice(0, lastNewline) : text;
}

function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const collectRuleDirectories = Effect.fn("AntigravityProjectRules.collectRuleDirectories")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const startDir = path.resolve(cwd);
    const exists = yield* fileSystem.exists(startDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as ReadonlyArray<string>;

    const ancestors: Array<string> = [];
    let current = startDir;
    let repoRootFound = false;
    while (true) {
      ancestors.push(current);
      const hasGit = yield* fileSystem
        .exists(path.join(current, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasGit) {
        repoRootFound = true;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return repoRootFound ? ancestors.toReversed() : [startDir];
  },
);

/**
 * Antigravity managed runtime 1.4.5 omits `HarnessConfig.rules_config`, so `localharness_external`
 * skips its `<user_rules>` section. Mirror its `GEMINI.md`/`AGENTS.md` discovery and 24,000-byte
 * per-file line-boundary cap for `systemPrompt.append` (which only applies to 1.4.5).
 */
export const loadAntigravityProjectRules = Effect.fn("AntigravityProjectRules.load")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = yield* collectRuleDirectories(cwd);
  if (directories.length === 0) return undefined;

  const seenRealPaths = new Set<string>();
  const sections: Array<string> = [];
  let totalBytes = 0;

  for (const directory of directories) {
    for (const filename of RULE_FILENAMES) {
      const candidate = path.join(directory, filename);
      const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;

      const canonical = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.orElseSucceed(() => candidate));
      if (seenRealPaths.has(canonical)) continue;
      seenRealPaths.add(canonical);

      const rawBytes = yield* fileSystem
        .stream(candidate, { bytesToRead: ANTIGRAVITY_RULE_FILE_MAX_BYTES + 4 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunks) => Buffer.concat(chunks)),
          Effect.option,
        );
      if (Option.isNone(rawBytes) || rawBytes.value.length === 0) continue;

      const overFileCap = rawBytes.value.length > ANTIGRAVITY_RULE_FILE_MAX_BYTES;
      const bounded = overFileCap
        ? sliceUtf8Buffer(rawBytes.value, ANTIGRAVITY_RULE_FILE_MAX_BYTES)
        : rawBytes.value;

      const decoded = decodeUtf8Text(bounded);
      if (decoded === undefined || decoded.includes("\0") || decoded.trim().length === 0) continue;

      const body = overFileCap ? truncateOnLineBoundary(decoded).trimEnd() : decoded.trimEnd();
      const bodyBytes = Buffer.byteLength(body, "utf8");

      if (totalBytes + bodyBytes > ANTIGRAVITY_RULES_TOTAL_MAX_BYTES) {
        sections.push(
          `<rule path="${candidate}">\n[Omitted to stay within the rules budget; read ${candidate} directly when needed.]\n</rule>`,
        );
        continue;
      }

      totalBytes += bodyBytes;
      const truncationNotice = overFileCap
        ? `\n\n[Truncated at ${ANTIGRAVITY_RULE_FILE_MAX_BYTES} bytes; read ${candidate} for the remaining content.]`
        : "";
      sections.push(`<rule path="${candidate}">\n${body}${truncationNotice}\n</rule>`);
    }
  }

  if (sections.length === 0) return undefined;
  return `<user_rules>\nThe following project rule files apply to this workspace:\n\n${sections.join("\n\n")}\n</user_rules>`;
});
