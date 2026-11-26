import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PullRequestOperationError,
  SourceControlProviderKind,
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
} from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const actorSchema = Schema.NullOr(
  Schema.Struct({
    login: Schema.String,
    avatar_url: Schema.NullOr(Schema.String),
  }),
);

const pullSchema = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  user: actorSchema,
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  merged_by: Schema.optional(actorSchema),
});

const checksSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.NullOr(Schema.String),
    }),
  ),
});

const remarksSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: actorSchema,
    body: Schema.NullOr(Schema.String),
    created_at: Schema.optional(Schema.String),
    updated_at: Schema.optional(Schema.String),
    submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.String,
    path: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
  }),
);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const errorSchema = Schema.Struct({ error: Schema.Number, message: Schema.NullOr(Schema.String) });
const operation = "readPermissionLabsWatch";
const fail = (reason: PullRequestProviderError["reason"], detail: string) =>
  new PullRequestOperationError({
    operation,
    detail,
    cause: new PullRequestProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      reason,
      detail,
    }),
  });

const actor = (user: typeof actorSchema.Type) =>
  user && { login: user.login, name: null, avatarUrl: user.avatar_url };

function checkStatus(
  check: (typeof checksSchema.Type)["check_runs"][number],
): PullRequestCheck["status"] {
  if (check.status !== "completed") return "pending";
  switch (check.conclusion) {
    case "success":
    case "skipped":
    case "neutral":
    case "cancelled":
      return check.conclusion;
    case "action_required":
      return "action-required";
    default:
      return "failure";
  }
}

export type WatchDetail = Pick<
  PullRequestDetail,
  | "state"
  | "baseBranch"
  | "headSha"
  | "checks"
  | "mergeability"
  | "viewer"
  | "author"
  | "rebaseRequired"
  | "mergeQueueRemoval"
  | "mergeCommitSha"
  | "mergedBy"
> & { readonly capabilities: Pick<PullRequestDetail["capabilities"], "checksAlwaysReport"> };

export function permissionLabsWatchRepo(host: string, repository: string) {
  return host === "github.com"
    ? /^permissionlabs\/([a-z0-9_.-]+)$/i.exec(repository)?.[1]
    : undefined;
}

export const read = Effect.fn("PermissionLabsWatchReader.read")(function* (
  executable: string,
  repo: string,
  number: number,
  includeActivity: boolean,
) {
  const runner = yield* ProcessRunner.make();
  const decode = Effect.fn("PermissionLabsWatchReader.decode")(function* <
    S extends Schema.Decoder<unknown>,
  >(schema: S, path: string) {
    const response = yield* runner
      .run({
        command: executable,
        args: [repo, path],
        timeout: "30 seconds",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(Effect.mapError(() => fail("failed", "Reader could not complete the command.")));
    if (response.code !== 0) {
      const reason = response.stderr.startsWith("pl-gh-read: token request failed")
        ? "unauthenticated"
        : "failed";
      return yield* fail(reason, "Reader command failed.");
    }
    const result = yield* decodeJson(response.stdout).pipe(
      Effect.mapError(() => fail("failed", "Reader returned invalid JSON.")),
    );
    if (Schema.is(errorSchema)(result)) {
      const rateLimited =
        result.error === 429 || (result.error === 403 && /rate limit/i.test(result.message ?? ""));
      const reason = rateLimited
        ? "rate-limited"
        : result.error === 401 || result.error === 403
          ? "unauthenticated"
          : result.error === 404
            ? "not-found"
            : "failed";
      return yield* fail(reason, `Reader returned HTTP ${result.error}.`);
    }
    return yield* Schema.decodeUnknownEffect(schema)(result).pipe(
      Effect.mapError(() => fail("failed", "Reader returned an unexpected response.")),
    );
  });

  const pull = yield* decode(pullSchema, `pulls/${number}`);
  const detail: WatchDetail = {
    state: pull.merged ? "merged" : pull.state,
    baseBranch: pull.base.ref,
    headSha: pull.head.sha,
    checks: [],
    mergeability:
      pull.mergeable === null ? "unknown" : pull.mergeable ? "mergeable" : "conflicting",
    author: actor(pull.user),
    capabilities: {},
    ...(pull.merged && pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {}),
    ...(pull.merged && pull.merged_by ? { mergedBy: actor(pull.merged_by)! } : {}),
  };
  if (detail.state !== "open") return { detail, activity: null };
  if (!/^[a-f0-9]{40}$/i.test(pull.head.sha)) {
    return yield* fail("failed", "Reader returned an invalid PR head.");
  }

  const readChecks = Effect.gen(function* () {
    const checks: PullRequestCheck[] = [];
    for (let page = 1; ; page++) {
      const response = yield* decode(
        checksSchema,
        `commits/${pull.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      checks.push(
        ...response.check_runs.map((check) => ({
          name: check.name,
          status: checkStatus(check),
          description: null,
          url: check.html_url,
        })),
      );
      if (response.check_runs.length < 100 || checks.length >= response.total_count) return checks;
    }
  });

  const readRemarks = Effect.fn("PermissionLabsWatchReader.readRemarks")(function* (
    kind: PullRequestComment["kind"],
    path: string,
  ) {
    const remarks: PullRequestComment[] = [];
    for (let page = 1; ; page++) {
      const response = yield* decode(remarksSchema, `${path}?per_page=100&page=${page}`);
      for (const item of response) {
        const createdAt = item.submitted_at ?? item.created_at;
        if (createdAt === undefined) continue;
        remarks.push({
          id: `${kind}:${item.id}`,
          kind,
          author: actor(item.user),
          body: item.body ?? "",
          createdAt,
          editedAt: item.updated_at ?? null,
          path: item.path ?? null,
          url: item.html_url,
          reviewState: item.state ?? null,
        });
      }
      if (response.length < 100) return remarks;
    }
  });

  const readActivity = Effect.all(
    [
      readRemarks("issue-comment", `issues/${number}/comments`),
      readRemarks("review-comment", `pulls/${number}/comments`),
      readRemarks("review", `pulls/${number}/reviews`),
    ],
    { concurrency: 3 },
  ).pipe(
    Effect.map((groups): PullRequestActivity => {
      const comments = groups.flat();
      return {
        comments,
        commentCount: comments.length,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
      };
    }),
  );

  const [checks, activity] = yield* Effect.all(
    [readChecks, includeActivity ? readActivity : Effect.succeed(null)],
    { concurrency: 2 },
  );
  return { detail: { ...detail, checks }, activity };
}, Effect.provide(NodeServices.layer));
