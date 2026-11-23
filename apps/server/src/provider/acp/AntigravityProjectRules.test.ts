import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_RULE_FILE_MAX_BYTES,
  loadAntigravityProjectRules,
} from "./AntigravityProjectRules.ts";

it.layer(NodeServices.layer)("loadAntigravityProjectRules", (it) => {
  it.effect("walks from cwd up to the git root in root-to-leaf order and stops at .git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-rules-git-" });
      const repo = path.join(root, "repo");
      const nested = path.join(repo, "packages", "api");
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(path.join(root, "AGENTS.md"), "outside repo rule");
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "repo root rule");
      yield* fs.writeFileString(path.join(nested, "GEMINI.md"), "package gemini rule");

      const rules = yield* loadAntigravityProjectRules(nested);
      expect(rules).toBeDefined();
      expect(rules).not.toContain("outside repo rule");
      expect(rules).toContain("repo root rule");
      expect(rules).toContain("package gemini rule");
      expect(rules!.indexOf("repo root rule")).toBeLessThan(rules!.indexOf("package gemini rule"));
    }),
  );

  it.effect("recognizes a git worktree .git file and deduplicates symlinked rule files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-rules-wt-" });
      const worktree = path.join(root, "wt");
      yield* fs.makeDirectory(worktree, { recursive: true });
      yield* fs.writeFileString(path.join(root, "AGENTS.md"), "parent outside worktree");
      yield* fs.writeFileString(path.join(worktree, ".git"), "gitdir: /tmp/fake-gitdir\n");
      const agentsPath = path.join(worktree, "AGENTS.md");
      yield* fs.writeFileString(agentsPath, "shared worktree rule");
      yield* fs.symlink(agentsPath, path.join(worktree, "GEMINI.md"));

      const rules = yield* loadAntigravityProjectRules(worktree);
      expect(rules).toBeDefined();
      expect(rules).not.toContain("parent outside worktree");
      expect(rules?.match(/shared worktree rule/g)).toHaveLength(1);
    }),
  );

  it.effect("loads only cwd rules when no git repository root exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-rules-plain-" });
      const child = path.join(parent, "child");
      yield* fs.makeDirectory(child, { recursive: true });
      yield* fs.writeFileString(path.join(parent, "AGENTS.md"), "parent rule");
      yield* fs.writeFileString(path.join(child, "AGENTS.md"), "child rule");

      const rules = yield* loadAntigravityProjectRules(child);
      expect(rules).toContain("child rule");
      expect(rules).not.toContain("parent rule");
    }),
  );

  it.effect("truncates oversized UTF-8 rule files at 24,000 bytes on a line boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-rules-cap-" });
      const agentsPath = path.join(workspace, "AGENTS.md");
      const line = "규칙-line-0123456789\n";
      const count = Math.ceil((ANTIGRAVITY_RULE_FILE_MAX_BYTES + 4000) / Buffer.byteLength(line));
      yield* fs.writeFileString(agentsPath, `${line.repeat(count)}TAIL_MARKER\n`);

      const rules = yield* loadAntigravityProjectRules(workspace);
      expect(rules).toBeDefined();
      expect(rules).toContain("규칙-line-0123456789");
      expect(rules).not.toContain("TAIL_MARKER");
      expect(rules).toContain(
        `[Truncated at ${ANTIGRAVITY_RULE_FILE_MAX_BYTES} bytes; read ${agentsPath}`,
      );
      const ruleBody = rules!
        .split(`<rule path="${agentsPath}">\n`)[1]!
        .split("\n\n[Truncated")[0]!;
      expect(Buffer.byteLength(ruleBody, "utf8")).toBeLessThanOrEqual(
        ANTIGRAVITY_RULE_FILE_MAX_BYTES,
      );
      expect(ruleBody.split("\n").every((entry) => entry === "규칙-line-0123456789")).toBe(true);
    }),
  );

  it.effect("returns undefined when no readable UTF-8 rule files exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-rules-empty-" });
      expect(yield* loadAntigravityProjectRules(workspace)).toBeUndefined();

      yield* fs.writeFile(path.join(workspace, "AGENTS.md"), new Uint8Array([0x61, 0, 0x62]));
      expect(yield* loadAntigravityProjectRules(workspace)).toBeUndefined();
    }),
  );
});
