import type * as GitHubAppModuleNamespace from "../auth/github-app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_ABANDONED_DESCRIPTION, REVIEW_STATUS_CONTEXT } from "@open-inspect/shared";

type GitHubAppModule = typeof GitHubAppModuleNamespace;

// The close-out mints an installation token; stubbed so these tests exercise the
// status write and the row lifecycle rather than GitHub App JWT signing.
vi.mock("../auth/github-app", async (importOriginal) => ({
  ...(await importOriginal<GitHubAppModule>()),
  getCachedInstallationToken: vi.fn(async () => "test-token"),
}));
import type { Principal } from "../auth/principal";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import {
  closeOutDeadReviewSessions,
  githubReviewRoutes,
  handleClaimReviewGeneration,
  handleReviewLeaseRelease,
  handleReviewOwnership,
  handleSweepStaleReviews,
} from "./github-reviews";
import type { SessionRouteContext } from "./session-route";
import { parsePattern, type RequestContext } from "./shared";

const GITHUB_BOT_PRINCIPAL: Principal = { kind: "service", service: "github-bot", actor: null };

function routeMatch(path: string, pattern: string): RegExpMatchArray {
  const match = path.match(parsePattern(pattern));
  if (!match) throw new Error("Expected route match");
  return match;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Minimal SqlDatabase double: dispatches on the leading SQL keywords the
 * routes actually issue (claim INSERT..RETURNING, sweep SELECT, sweep
 * DELETE) rather than modeling a real engine.
 */
function createFakeDb(
  config: {
    claimGeneration?: number;
    staleSessionIds?: string[];
    staleRowCreatedAt?: number;
    /** Lease columns returned on stale rows (sweep/reaper defer test). */
    staleRowLease?: { lease_session_id: string; lease_expires_at: number };
    /** meta.changes for the lease-acquire UPDATE (ownership handler). */
    leaseAcquireChanges?: number;
  } = {}
): {
  db: SqlDatabase;
  deletedSessionIds: string[];
  leaseReleases: number;
} {
  const deletedSessionIds: string[] = [];
  const counters = { leaseReleases: 0 };
  const db = {
    prepare(sql: string) {
      const trimmed = sql.trim();
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (trimmed.startsWith("INSERT INTO github_review_state")) {
                return { latest_generation: config.claimGeneration ?? 1 } as unknown as T;
              }
              return null;
            },
            async all<T>() {
              if (trimmed.startsWith("SELECT grs.session_id")) {
                const ids = config.staleSessionIds ?? [];
                // Default to epoch 0: rows old enough that a 404 proves a
                // true orphan. Fresh-row tests override staleRowCreatedAt.
                const created_at = config.staleRowCreatedAt ?? 0;
                const lease = config.staleRowLease ?? {
                  lease_session_id: null,
                  lease_expires_at: null,
                };
                return {
                  results: ids.map((session_id) => ({
                    session_id,
                    created_at,
                    ...lease,
                  })) as unknown as T[],
                  meta: { changes: 0 },
                };
              }
              return { results: [] as T[], meta: { changes: 0 } };
            },
            async run<T>() {
              if (trimmed.startsWith("DELETE FROM github_review_sessions")) {
                deletedSessionIds.push(values[2] as string);
              }
              if (trimmed.startsWith("UPDATE github_review_state SET lease_session_id = NULL")) {
                counters.leaseReleases += 1;
                return { results: [] as T[], meta: { changes: 1 } };
              }
              if (trimmed.startsWith("UPDATE github_review_state SET lease_session_id")) {
                return { results: [] as T[], meta: { changes: config.leaseAcquireChanges ?? 1 } };
              }
              return { results: [] as T[], meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as SqlDatabase;
  return {
    db,
    deletedSessionIds,
    get leaseReleases() {
      return counters.leaseReleases;
    },
  };
}

function requestContext(db: SqlDatabase, principal?: Principal): RequestContext {
  return {
    db,
    metrics: {} as RequestContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    executionCtx: { submit: vi.fn() },
    principal,
  };
}

function sweepContext(
  db: SqlDatabase,
  fetchImpl: SessionRuntimeClient["fetch"],
  principal?: Principal
): SessionRouteContext {
  return { ...requestContext(db, principal), sessionRuntime: { fetch: fetchImpl } };
}

describe("auth gating", () => {
  it.each(["/internal/github-reviews/claim", "/internal/github-reviews/sweep"])(
    "declares %s as github-bot-only service authorization",
    (path) => {
      const route = githubReviewRoutes.find((candidate) => candidate.pattern.test(path));
      if (!route) throw new Error(`No route registered for ${path}`);

      expect(route.authentication).toEqual({ kind: "service" });
      expect(route.authorization).toEqual({
        kind: "service",
        services: ["github-bot"],
        actor: "optional",
      });
    }
  );
});

describe("handleClaimReviewGeneration", () => {
  it("returns the generation the atomic upsert produced", async () => {
    const { db } = createFakeDb({ claimGeneration: 4 });

    const response = await handleClaimReviewGeneration(
      jsonRequest("https://test.local/internal/github-reviews/claim", {
        repoId: 555,
        prNumber: 42,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/claim", "/internal/github-reviews/claim"),
      requestContext(db, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ generation: 4 });
  });

  it("rejects a non-positive prNumber", async () => {
    const { db } = createFakeDb();

    const response = await handleClaimReviewGeneration(
      jsonRequest("https://test.local/internal/github-reviews/claim", {
        repoId: 555,
        prNumber: 0,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/claim", "/internal/github-reviews/claim"),
      requestContext(db, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(400);
  });
});

describe("handleSweepStaleReviews", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cancels a stale session with no descendants and deletes its row", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-1"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-1"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-1"]);
  });

  it("treats a 409 primary cancel as already-terminal and deletes the row", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-409"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "already terminal" }, { status: 409 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-409"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-409"]);
  });

  it("treats a 404 primary cancel on an aged row as an orphaned DO and deletes it", async () => {
    const listActiveDescendantIds = vi.spyOn(
      SessionIndexStore.prototype,
      "listActiveDescendantIds"
    );
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-404"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "not found" }, { status: 404 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["stale-404"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["stale-404"]);
    // A 404 means the DO never existed — no descendants to look up.
    expect(listActiveDescendantIds).not.toHaveBeenCalled();
  });

  it("retains a fresh row on a 404 — its create may still be mid-init", async () => {
    const listActiveDescendantIds = vi.spyOn(
      SessionIndexStore.prototype,
      "listActiveDescendantIds"
    );
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["stale-fresh-404"],
      staleRowCreatedAt: Date.now(),
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "not found" }, { status: 404 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["stale-fresh-404"],
    });
    expect(deletedSessionIds).toEqual([]);
    expect(listActiveDescendantIds).not.toHaveBeenCalled();
  });

  it("keeps the row and reports failure when the primary cancel errors", async () => {
    const { db, deletedSessionIds } = createFakeDb({ staleSessionIds: ["stale-failed"] });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () =>
      Response.json({ error: "internal error" }, { status: 500 })
    );

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["stale-failed"],
    });
    expect(deletedSessionIds).toEqual([]);
  });

  it("keeps the row when a descendant cancel fails, but tolerates a 409 descendant", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockImplementation(
      async (sessionId) => (sessionId === "with-bad-descendant" ? ["child-1"] : ["child-2"])
    );
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["with-bad-descendant", "with-terminal-descendant"],
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child-1") return Response.json({ error: "failure" }, { status: 500 });
      if (sessionId === "child-2") return Response.json({ error: "terminal" }, { status: 409 });
      return Response.json({ status: "ok" });
    });

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["with-terminal-descendant"],
      failedSessionIds: ["with-bad-descendant"],
    });
    expect(deletedSessionIds).toEqual(["with-terminal-descendant"]);
  });

  it("rejects a non-positive generation", async () => {
    const { db } = createFakeDb();

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: -1,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, vi.fn(), GITHUB_BOT_PRINCIPAL)
    );

    expect(response.status).toBe(400);
  });
});

describe("handleReviewOwnership / handleReviewLeaseRelease", () => {
  const OWNERSHIP_PATH = "/sessions/session-1/review-ownership";
  const OWNERSHIP_PATTERN = "/sessions/:id/review-ownership";
  const SANDBOX_PRINCIPAL: Principal = { kind: "sandbox", sessionId: "session-1" };

  function ownershipRequest(method = "GET"): Request {
    return new Request(`https://test.local${OWNERSHIP_PATH}`, { method });
  }

  it("returns 204 and acquires the lease while the caller is the latest generation", async () => {
    const { db } = createFakeDb({ leaseAcquireChanges: 1 });

    const response = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(204);
  });

  it("returns 409 when superseded, swept, or another session holds an unexpired lease", async () => {
    // The atomic UPDATE matches no row in all three cases; the handler only
    // observes changes === 0.
    const { db } = createFakeDb({ leaseAcquireChanges: 0 });

    const response = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(409);
  });

  it("release clears only the caller's lease and returns 204", async () => {
    const fake = createFakeDb();

    const response = await handleReviewLeaseRelease(
      ownershipRequest("DELETE"),
      {} as Env,
      routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN),
      requestContext(fake.db, SANDBOX_PRINCIPAL)
    );

    expect(response.status).toBe(204);
    expect(fake.leaseReleases).toBe(1);
  });

  it.each([
    ["a service principal", GITHUB_BOT_PRINCIPAL],
    [
      "a sandbox principal for a different session",
      { kind: "sandbox", sessionId: "other" } as Principal,
    ],
    ["no principal", undefined],
  ])("rejects %s on acquire and release", async (_name, principal) => {
    const { db } = createFakeDb({ leaseAcquireChanges: 1 });
    const match = routeMatch(OWNERSHIP_PATH, OWNERSHIP_PATTERN);

    const acquire = await handleReviewOwnership(
      ownershipRequest(),
      {} as Env,
      match,
      requestContext(db, principal)
    );
    const release = await handleReviewLeaseRelease(
      ownershipRequest("DELETE"),
      {} as Env,
      match,
      requestContext(db, principal)
    );

    expect(acquire.status).toBe(401);
    expect(release.status).toBe(401);
  });
});

describe("sweep lease deferral", () => {
  it("retains a stale row whose session holds an unexpired submission lease", async () => {
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["leaseholder"],
      staleRowLease: { lease_session_id: "leaseholder", lease_expires_at: Date.now() + 60_000 },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: [],
      failedSessionIds: ["leaseholder"],
    });
    expect(deletedSessionIds).toEqual([]);
    // The cancel must never even be attempted against the leaseholder's DO.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels normally once the leaseholder's lease has expired", async () => {
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([]);
    const { db, deletedSessionIds } = createFakeDb({
      staleSessionIds: ["expired-lease"],
      staleRowLease: { lease_session_id: "expired-lease", lease_expires_at: Date.now() - 1000 },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => Response.json({ status: "ok" }));

    const response = await handleSweepStaleReviews(
      jsonRequest("https://test.local/internal/github-reviews/sweep", {
        repoId: 1,
        prNumber: 2,
        generation: 3,
      }),
      {} as Env,
      routeMatch("/internal/github-reviews/sweep", "/internal/github-reviews/sweep"),
      sweepContext(db, fetch, GITHUB_BOT_PRINCIPAL)
    );

    await expect(response.json()).resolves.toEqual({
      cancelledSessionIds: ["expired-lease"],
      failedSessionIds: [],
    });
    expect(deletedSessionIds).toEqual(["expired-lease"]);
  });
});

/**
 * Answers the close-out's SELECT and records what it wrote. The fake above is
 * shaped for the sweep; this one models the three things the close-out's
 * correctness rests on — which rows the query returns, whether the lease UPDATE
 * lands, and which rows were deleted.
 */
/** Scripts the status GET the close-out now makes before it writes. */
function mockGitHub(options: {
  existing?: { context: string; state: string }[];
  postResponse?: Response;
  getResponse?: Response;
  pullRequest?: { state: string; merged?: boolean };
  pullRequestResponse?: Response;
}) {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/pulls/")) {
        return (
          options.pullRequestResponse ??
          new Response(JSON.stringify(options.pullRequest ?? { state: "open", merged: false }))
        );
      }
      if (url.split("?")[0]!.endsWith("/status") && (init?.method ?? "GET") === "GET") {
        return (
          options.getResponse ?? new Response(JSON.stringify({ statuses: options.existing ?? [] }))
        );
      }
      return options.postResponse ?? new Response("{}");
    });
  return { fetchMock, calls, posts: () => calls.filter((call) => call.method === "POST") };
}

function createCloseOutDb(
  rows: Record<string, unknown>[],
  options: { leaseAcquired?: boolean; superseded?: boolean } = {}
): { db: SqlDatabase; deleted: string[]; leaseReleased: string[] } {
  const deleted: string[] = [];
  const leaseReleased: string[] = [];
  const db = {
    prepare(sql: string) {
      const binds: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          binds.push(...args);
          return statement;
        },
        async all() {
          // Mirrors the SQL's own predicate, so a row the real query would never
          // return cannot reach the loop through the fake.
          return {
            results: rows.filter((row) => row.status === "failed" || row.status === "cancelled"),
          };
        },
        async run() {
          if (sql.startsWith("DELETE")) deleted.push(binds[0] as string);
          if (sql.includes("lease_session_id = NULL")) leaseReleased.push(binds[2] as string);
          if (sql.includes("SET lease_session_id = ?1")) {
            return { meta: { changes: options.leaseAcquired === false ? 0 : 1 } };
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          // The generation re-check before the POST; null means superseded.
          return options.superseded === true ? null : { 1: 1 };
        },
      };
      return statement;
    },
  } as unknown as SqlDatabase;
  return { db, deleted, leaseReleased };
}

function closeOutRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    session_id: "sess-dead",
    repo_id: 42,
    pr_number: 7,
    head_sha: "abc123",
    created_at: Date.now(),
    status: "failed",
    message_count: 1,
    active_duration_ms: 1000,
    repo_owner: "opencodos",
    repo_name: "aitaas",
    ...overrides,
  };
}

const CLOSE_OUT_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_APP_INSTALLATION_ID: "2",
} as unknown as Env;

describe("closeOutDeadReviewSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the abandoned status for a session that died, and drops the row", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { fetchMock, posts } = mockGitHub({
      existing: [{ context: "open-inspect", state: "pending" }],
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls.find((call) => call[1]?.method === "POST")!;
    expect(url).toBe("https://api.github.com/repos/opencodos/aitaas/statuses/abc123");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      state: "error",
      context: REVIEW_STATUS_CONTEXT,
      description: REVIEW_ABANDONED_DESCRIPTION,
    });
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("leaves a completed review alone however old it is", async () => {
    // A successful publication releases its lease but never deletes this row, so
    // an age-based predicate here would post `error` over a landed verdict.
    const { db, deleted } = createCloseOutDb([
      closeOutRow({ status: "completed", created_at: Date.now() - 24 * 60 * 60 * 1000 }),
    ]);
    const { fetchMock } = mockGitHub({});

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("leaves a long-running active review alone", async () => {
    const { db, deleted } = createCloseOutDb([
      closeOutRow({ status: "active", created_at: Date.now() - 3 * 60 * 60 * 1000 }),
    ]);
    const { fetchMock } = mockGitHub({});

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("defers when the submission lease cannot be taken", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()], { leaseAcquired: false });
    const { fetchMock } = mockGitHub({});

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("addresses the repository the review was for, not the session's first repo", async () => {
    const { db } = createCloseOutDb([closeOutRow({ repo_owner: "opencodos", repo_name: "other" })]);
    const { posts } = mockGitHub({ existing: [] });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()[0]!.url).toBe("https://api.github.com/repos/opencodos/other/statuses/abc123");
  });

  it("retains the row and hands back the lease when the status write fails", async () => {
    const { db, deleted, leaseReleased } = createCloseOutDb([closeOutRow()]);
    mockGitHub({ postResponse: new Response("nope", { status: 500 }) });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(deleted).toEqual([]);
    expect(leaseReleased).toHaveLength(1);
  });

  it("retries a 422 that is not a missing commit", async () => {
    // GitHub also answers 422 for validation and abuse rejections; discarding
    // the row on those would recreate the permanently-pending state.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    mockGitHub({
      postResponse: new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(deleted).toEqual([]);
  });

  it("treats a sha GitHub cannot find as done — a force-push left nothing to describe", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    mockGitHub({
      postResponse: new Response(JSON.stringify({ message: "No commit found for SHA: abc123" }), {
        status: 422,
      }),
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(deleted).toEqual(["sess-dead"]);
  });

  it("does nothing when the GitHub App is not configured", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await closeOutDeadReviewSessions(db as RequestContext["db"], {} as Env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("does not overwrite a verdict the agent published just before it died", async () => {
    // The agent posts its status, then releases the lease, then execution
    // completion is recorded. Killed in that window the session is `failed`
    // while a good status already sits on the commit.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({ existing: [{ context: "open-inspect", state: "success" }] });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("retries when the existing status cannot be read, rather than posting blind", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({ getResponse: new Response("boom", { status: 500 }) });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("drops a row with no repository identity instead of retrying it forever", async () => {
    // It can never be posted for, so retaining it would hold a batch slot every
    // minute and starve every dead review behind it.
    const { db, deleted } = createCloseOutDb([closeOutRow({ repo_owner: null, repo_name: null })]);
    const { fetchMock } = mockGitHub({});

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("does not post on a pull request that has already merged", async () => {
    // The common shape: a review requested seconds before the merge, abandoned
    // with nothing wrong. Nobody is waiting on that commit's check.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({ pullRequest: { state: "closed", merged: true } });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("does not post on a pull request that was closed unmerged", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({ pullRequest: { state: "closed", merged: false } });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("retries when the pull request state cannot be read", async () => {
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({
      pullRequestResponse: new Response("boom", { status: 500 }),
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("keeps retrying when the status lookup 404s, which does not prove the sha is gone", async () => {
    // An installation that lost access to a private repository answers 404 just
    // as a deleted commit does, so discarding the row here would strand the
    // pending status even once access returns.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({ getResponse: new Response("gone", { status: 404 }) });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("treats a sha the status lookup reports missing as settled, without posting", async () => {
    // 422 naming the sha is proof, where a bare 404 is not.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({
      getResponse: new Response(JSON.stringify({ message: "No commit found for SHA: abc123" }), {
        status: 422,
      }),
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual(["sess-dead"]);
  });

  it("releases only its own lease, never a later attempt's", async () => {
    // Two ticks can overlap on one row: an attempt spans three GitHub round trips
    // while the cron fires every minute. Keyed on the session id, the loser would
    // release the winner's lease mid-write.
    const { db, leaseReleased } = createCloseOutDb([closeOutRow()]);
    mockGitHub({ postResponse: new Response("nope", { status: 500 }) });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(leaseReleased).toHaveLength(1);
    expect(leaseReleased[0]).not.toBe("sess-dead");
  });

  it("does not overwrite a successor review that claimed the head mid-flight", async () => {
    // A new generation can be claimed while the GitHub reads are in flight; its
    // pending status must not be reported as a dead review.
    const { db, deleted } = createCloseOutDb([closeOutRow()], { superseded: true });
    const { posts } = mockGitHub({ existing: [{ context: "open-inspect", state: "pending" }] });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("keeps retrying a pull request GitHub answers 404 for", async () => {
    // A lost installation answers 404 exactly like a deleted pull request, so
    // dropping the row would strand the pending status even once access returns.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts } = mockGitHub({
      pullRequestResponse: new Response("Not Found", { status: 404 }),
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("reads the latest status per context rather than a page of history", async () => {
    // The combined endpoint collapses to one entry per context; a verdict must
    // not be missed because other contexts reported many times since.
    const { db, deleted } = createCloseOutDb([closeOutRow()]);
    const { posts, calls } = mockGitHub({
      existing: [
        { context: "ci", state: "success" },
        { context: "open-inspect", state: "failure" },
      ],
    });

    await closeOutDeadReviewSessions(db as RequestContext["db"], CLOSE_OUT_ENV);

    expect(calls.some((c) => c.url.split("?")[0]!.endsWith("/status"))).toBe(true);
    expect(posts()).toHaveLength(0);
    expect(deleted).toEqual(["sess-dead"]);
  });
});
