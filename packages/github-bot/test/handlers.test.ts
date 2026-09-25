import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type * as GitHubAuthModule from "../src/github-auth";
import type {
  Env,
  PullRequestReviewTriggerPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuthModule>()),
  generateInstallationToken: vi.fn().mockResolvedValue("test-installation-token"),
  postCommitStatus: vi.fn().mockResolvedValue({ ok: true }),
  postReaction: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
  getPullRequestSnapshot: vi
    .fn()
    .mockResolvedValue({ ok: true, headSha: "abc123", state: "open", draft: false }),
  getReviewStatusState: vi.fn().mockResolvedValue({ ok: true, state: "pending" }),
  getPullRequestApproval: vi.fn().mockResolvedValue({ ok: true, approved: false }),
}));

vi.mock("../src/utils/integration-config", () => ({
  getGitHubConfig: vi.fn().mockResolvedValue({
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    autoReviewOnOpen: true,
    enabledRepos: null,
    allowedTriggerUsers: null,
    codeReviewInstructions: null,
    commentActionInstructions: null,
  }),
}));

const defaultConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-haiku-4-5",
  reasoningEffort: null,
  autoReviewOnOpen: true,
  enabledRepos: null,
  allowedTriggerUsers: null,
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

import {
  handlePullRequestReviewTrigger,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
} from "../src/handlers";
import {
  generateInstallationToken,
  postCommitStatus,
  postReaction,
  checkSenderPermission,
  getPullRequestSnapshot,
  getPullRequestApproval,
  getReviewStatusState,
} from "../src/github-auth";
import { getGitHubConfig } from "../src/utils/integration-config";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

const CLOSE_OUT_URL = "https://internal/internal/github-reviews/close-out";
const FINALIZE_URL = "https://internal/internal/github-reviews/close-out/finalize";

/** JSON bodies of every control-plane call to `url`, in call order. */
function controlPlaneBodies(cpFetch: Mock, url: string): unknown[] {
  return cpFetch.mock.calls
    .filter(([calledUrl]: [string]) => calledUrl === url)
    .map(([, init]: [string, { body: string }]) => JSON.parse(init.body));
}

/**
 * Default responses for the review-supersession claim/sweep/close-out routes.
 * Shared by every custom control-plane fetch mock below so new-session
 * fencing never derails a test whose focus is elsewhere.
 */
function defaultReviewSupersessionResponse(url: string): Response | null {
  if (url === "https://internal/internal/github-reviews/claim") {
    return new Response(JSON.stringify({ generation: 1 }), { status: 200 });
  }
  if (url === "https://internal/internal/github-reviews/release-claim") {
    return new Response(JSON.stringify({ released: true }), { status: 200 });
  }
  if (url === "https://internal/internal/github-reviews/sweep") {
    return new Response(
      JSON.stringify({ cancelledSessionIds: [], deferredSessionIds: [], failedSessionIds: [] }),
      { status: 200 }
    );
  }
  if (url === CLOSE_OUT_URL) {
    return Response.json({
      outcome: "granted",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: "abc123",
      description: "Review failed to start",
      superseded: false,
      leaseExpiresInMs: 120_000,
    });
  }
  if (url === FINALIZE_URL) return new Response(null, { status: 204 });
  return null;
}

function createMockEnv(): Env {
  const controlPlaneFetch = vi.fn().mockImplementation((url: string) => {
    const supersession = defaultReviewSupersessionResponse(url);
    if (supersession) return Promise.resolve(supersession);
    if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
      );
    }
    if (url === "https://internal/sessions") {
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
          status: 200,
        })
      );
    }
    if (/\/sessions\/.+\/prompt$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  });

  return {
    GITHUB_KV: { get: vi.fn(), put: vi.fn() },
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function getControlPlaneFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

/**
 * Locate control-plane calls by URL rather than index — handlers make a
 * session-target metadata lookup before creating the session.
 */
function findCallBody(cpFetch: ReturnType<typeof vi.fn>, urlPattern: RegExp) {
  const call = cpFetch.mock.calls.find(([url]) => urlPattern.test(String(url)));
  expect(call).toBeDefined();
  return JSON.parse((call as [string, { body: string }])[1].body);
}

function sessionCreateBody(cpFetch: ReturnType<typeof vi.fn>) {
  return findCallBody(cpFetch, /^https:\/\/internal\/sessions$/);
}

function promptSendBody(cpFetch: ReturnType<typeof vi.fn>) {
  return findCallBody(cpFetch, /\/sessions\/.+\/prompt$/);
}

const pullRequestReviewTriggerPayload: PullRequestReviewTriggerPayload = {
  action: "opened",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
    draft: false,
  },
  repository: { id: 501, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
};

const reviewRequestedPayload: ReviewRequestedPayload = {
  action: "review_requested",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  requested_reviewer: { login: "test-bot[bot]" },
  repository: { id: 501, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
};

const issueCommentPayload: IssueCommentPayload = {
  action: "created",
  issue: {
    number: 42,
    title: "Add caching",
    pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
  },
  comment: {
    id: 100,
    body: "@test-bot[bot] please fix the error handling",
    user: { login: "bob" },
  },
  repository: { id: 501, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "bob", id: 1002, avatar_url: "https://avatars.githubusercontent.com/u/1002" },
};

const reviewCommentPayload: ReviewCommentPayload = {
  action: "created",
  pull_request: {
    number: 42,
    title: "Add caching",
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  comment: {
    id: 200,
    body: "@test-bot[bot] can you fix this?",
    path: "src/cache.ts",
    diff_hunk: "@@ -10,3 +10,5 @@\n+const cache = new Map();",
    position: 5,
    user: { login: "carol" },
  },
  repository: { id: 501, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "carol", id: 1003, avatar_url: "https://avatars.githubusercontent.com/u/1003" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("test-installation-token");
  vi.mocked(postCommitStatus).mockResolvedValue({ ok: true });
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(getPullRequestSnapshot).mockResolvedValue({
    ok: true,
    headSha: "abc123",
    state: "open",
    draft: false,
  });
  vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: false });
  vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: "pending" });
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
});

describe("handlePullRequestReviewTrigger", () => {
  it("leaves a replaced head's status to that review's own close-out", async () => {
    // The replaced head's review is closed out under the submission lease, through its fence
    // row: the handler writes nothing to that commit, and names the repository so the sweep can
    // record the close-out.
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
      before: "oldsha1",
    } as PullRequestReviewTriggerPayload;

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(
      vi.mocked(postCommitStatus).mock.calls.filter(([, , , sha]) => sha === "oldsha1")
    ).toEqual([]);
    const sweepCalls = getControlPlaneFetch(env).mock.calls.filter(
      ([url]: [string]) => url === "https://internal/internal/github-reviews/sweep"
    );
    expect(JSON.parse(sweepCalls[0][1].body)).toEqual({
      repoId: 501,
      prNumber: 42,
      generation: 1,
      owner: "acme",
      repo: "widgets",
    });
  });

  it("posts a pending status for the synchronized head and starts a review", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(postCommitStatus).toHaveBeenCalledWith(
      "test-installation-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "pending",
        context: "open-inspect",
        description: "Review in progress",
      },
      "Open-Inspect"
    );
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(5);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.source).toBe("github");
    expect(promptBody).not.toHaveProperty("authorId");
    expect(promptBody.content).toContain("Pull Request #42");
    expect(promptBody.content).toContain("repos/acme/widgets/statuses/abc123");
    expect(promptBody.content).toContain('-f target_url="$review_url"');
    // The review's end comes back to the bot, naming the commit its pending status sits on.
    expect(promptBody.callbackContext).toEqual({
      source: "github",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: "abc123",
    });

    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({ action: "auto_review" })
    );
  });

  it("continues the review and logs why the installation cannot post statuses", async () => {
    vi.mocked(postCommitStatus).mockResolvedValue({
      ok: false,
      status: 403,
      error: "GitHub API returned 403",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-permission-pending"
    );

    expect(result.outcome).toBe("processed");
    expect(log.warn).toHaveBeenCalledWith("review_status.failed", {
      trace_id: "trace-permission-pending",
      repo: "acme/widgets",
      pull_number: 42,
      head_sha: "abc123",
      state: "pending",
      github_status: 403,
      error: "GitHub API returned 403",
    });
  });

  it("rejects a malformed session creation response before sending a prompt", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (url === "https://internal/sessions") {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    const log = createMockLogger();

    await expect(
      handlePullRequestReviewTrigger(env, log, pullRequestReviewTriggerPayload, "trace-0")
    ).rejects.toThrow("Session creation failed: invalid response");

    // The claim bumped the fence but no session carries it, so the handler
    // must release it — conditionally, on exactly the generation it claimed —
    // before rethrowing. Without this a review still running on the previous
    // generation would be permanently locked out of submitting.
    const releaseCalls = cpFetch.mock.calls.filter(
      ([url]: [string]) => url === "https://internal/internal/github-reviews/release-claim"
    );
    expect(releaseCalls).toHaveLength(1);
    expect(JSON.parse(releaseCalls[0][1].body)).toEqual({
      repoId: 501,
      prNumber: 42,
      generation: 1,
    });
    // No sweep ran: the superseding session never existed.
    expect(
      cpFetch.mock.calls.filter(
        ([url]: [string]) => url === "https://internal/internal/github-reviews/sweep"
      )
    ).toHaveLength(0);
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("closes out through the lease when prompt delivery fails", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
        );
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
            status: 200,
          })
        );
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(new Response("Unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    await expect(
      handlePullRequestReviewTrigger(
        env,
        createMockLogger(),
        pullRequestReviewTriggerPayload,
        "trace-prompt-failed"
      )
    ).rejects.toThrow("Prompt delivery failed: 503 Unavailable");

    expect(controlPlaneBodies(cpFetch, CLOSE_OUT_URL)).toEqual([
      {
        sessionId: "session-123",
        request: { owner: "acme", repo: "widgets", description: "Review failed to start" },
      },
    ]);
    expect(postCommitStatus).toHaveBeenLastCalledWith(
      "test-installation-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "error",
        context: "open-inspect",
        description: "Review failed to start",
      },
      "Open-Inspect"
    );
    expect(controlPlaneBodies(cpFetch, FINALIZE_URL)).toEqual([
      { sessionId: "session-123", outcome: "done" },
    ]);
  });

  it("writes no error status for a failed prompt delivery the close-out defers", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      if (url === CLOSE_OUT_URL) {
        return Promise.resolve(Response.json({ outcome: "deferred" }, { status: 202 }));
      }
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (url === "https://internal/sessions") {
        return Promise.resolve(Response.json({ sessionId: "session-123", status: "created" }));
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(new Response("Unavailable", { status: 503 }));
      }
      return Promise.resolve(Response.json({ repo: "acme/widgets", metadata: null }));
    });

    await expect(
      handlePullRequestReviewTrigger(
        env,
        createMockLogger(),
        pullRequestReviewTriggerPayload,
        "trace-prompt-deferred"
      )
    ).rejects.toThrow("Prompt delivery failed: 503 Unavailable");

    const errorStatuses = vi
      .mocked(postCommitStatus)
      .mock.calls.filter(([, , , , status]) => status.state === "error");
    expect(errorStatuses).toEqual([]);
    expect(controlPlaneBodies(cpFetch, FINALIZE_URL)).toEqual([]);
  });

  it("returns early for draft PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: { ...pullRequestReviewTriggerPayload.pull_request, draft: true },
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "draft_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.draft_pr_skipped", expect.anything());
  });

  it("reviews a bot-authored PR when the bot is an allowed trigger user", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["test-bot[bot]"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: {
        ...pullRequestReviewTriggerPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(sessionCreateBody(getControlPlaneFetch(env)).scmLogin).toBe("test-bot[bot]");
    expect(promptSendBody(getControlPlaneFetch(env)).content).toContain('"event": "COMMENT"');
  });

  it("approves a bot-authored PR when a separate reviewer App submits the review", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["test-bot[bot]"],
    });
    const env = { ...createMockEnv(), GITHUB_REVIEWER_USERNAME: "test-reviewer[bot]" };
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: {
        ...pullRequestReviewTriggerPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    const content = promptSendBody(getControlPlaneFetch(env)).content;
    // The reviewer App is not the PR's author, so GitHub accepts an approval.
    expect(content).toContain('"event": "<APPROVE, REQUEST_CHANGES, or COMMENT>"');
    expect(content).toContain("/sessions/$session_id/review-token");
  });

  it("still comments on a PR the reviewer App itself opened", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["test-reviewer[bot]"],
    });
    const env = { ...createMockEnv(), GITHUB_REVIEWER_USERNAME: "test-reviewer[bot]" };
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: {
        ...pullRequestReviewTriggerPayload.pull_request,
        user: { login: "test-reviewer[bot]" },
      },
      sender: {
        login: "test-reviewer[bot]",
        id: 1005,
        avatar_url: "https://avatars.githubusercontent.com/u/1005",
      },
    };

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(promptSendBody(getControlPlaneFetch(env)).content).toContain('"event": "COMMENT"');
  });

  it("omits the reviewer token fetch when no reviewer App is configured", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestReviewTrigger(env, log, pullRequestReviewTriggerPayload, "trace-0");

    expect(promptSendBody(getControlPlaneFetch(env)).content).not.toContain("review-token");
  });

  it("reviews a bot-opened PR even when the allowlist names only humans", async () => {
    // A PR this app opened arrives with the app itself as sender. An operator's allowlist names
    // the people who may direct the bot, so it never names the bot — reading it as a verdict on
    // the app's own actions is what silently dropped every self-opened PR.
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: {
        ...pullRequestReviewTriggerPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
  });

  it("reviews a bot-opened PR without consulting the collaborator-permission API", async () => {
    // That lookup 404s for a `[bot]` login, which the gate reads as permission_check_failed.
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false, error: true });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      pull_request: {
        ...pullRequestReviewTriggerPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "auto_review" });
    expect(checkSenderPermission).not.toHaveBeenCalled();
  });

  it("skips the auto review when the PR already carries a standing approval", async () => {
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_approved" });
    expect(
      getControlPlaneFetch(env).mock.calls.some(([url]) => url === "https://internal/sessions")
    ).toBe(false);
  });

  it("fences in-flight reviews and leaves the replaced head to their close-out", async () => {
    // Claiming supersedes every running review, so none can take the submission lease again; the
    // sweep names the repository, so the review of the head this push replaced is closed out under
    // the lease like any other ending. The handler itself writes nothing to the replaced head.
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
      before: "oldsha1",
    };

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    expect(findCallBody(cpFetch, /github-reviews\/claim$/)).toEqual({ repoId: 501, prNumber: 42 });
    expect(findCallBody(cpFetch, /github-reviews\/sweep$/)).toEqual({
      repoId: 501,
      prNumber: 42,
      generation: 1,
      owner: "acme",
      repo: "widgets",
    });
    const statuses = vi
      .mocked(postCommitStatus)
      .mock.calls.map(([, , , sha, status]) => [sha, status.state, status.description]);
    expect(statuses).toEqual([["abc123", "success", "Skipped — PR already approved"]]);
  });

  it("writes the skip after the claim and before the sweep", async () => {
    // After the claim no older review can start a status write; before the sweep, no close-out
    // of a same-head review it cancels has been requested — so that close-out finds the skip
    // already terminal and writes nothing.
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "reopened",
    };

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const callOrder = (url: string) =>
      cpFetch.mock.invocationCallOrder[
        cpFetch.mock.calls.findIndex(([calledUrl]: [string]) => calledUrl === url)
      ];
    const statusWrite = vi.mocked(postCommitStatus).mock.invocationCallOrder[0];
    expect(callOrder("https://internal/internal/github-reviews/claim")).toBeLessThan(statusWrite);
    expect(statusWrite).toBeLessThan(callOrder("https://internal/internal/github-reviews/sweep"));
  });

  it("writes the skip once while a same-head review still holds the lease", async () => {
    // The sweep defers a review mid-submission (its lease is live) rather than cancel it. The
    // handler cannot see that lease: it wrote the skip over a still-pending status and leaves the
    // leaseholder's own verdict, if it lands later, to win. It never writes after the sweep.
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    const fallback = cpFetch.getMockImplementation()!;
    cpFetch.mockImplementation((url: string, init: unknown) =>
      url === "https://internal/internal/github-reviews/sweep"
        ? Promise.resolve(
            Response.json({
              cancelledSessionIds: [],
              deferredSessionIds: ["leaseholder"],
              failedSessionIds: [],
            })
          )
        : fallback(url, init)
    );
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "ready_for_review",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_approved" });
    expect(postCommitStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postCommitStatus).mock.invocationCallOrder[0]).toBeLessThan(
      cpFetch.mock.invocationCallOrder[cpFetch.mock.invocationCallOrder.length - 1]
    );
  });

  it("keeps a verdict a same-head review already published", async () => {
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: "success" });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "reopened",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_approved" });
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("marks a fresh head that carries no status yet as skipped", async () => {
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    vi.mocked(getReviewStatusState).mockResolvedValue({ ok: true, state: null });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(
      vi.mocked(postCommitStatus).mock.calls.map(([, , , sha, status]) => [sha, status.state])
    ).toEqual([["abc123", "success"]]);
  });

  it("writes no skip when the head's status cannot be read", async () => {
    // An unreadable status is not evidence it is still pending: writing could replace a verdict.
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    vi.mocked(getReviewStatusState).mockResolvedValue({
      ok: false,
      error: "GitHub API returned 502",
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_approved" });
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("still skips an approved PR when the claim fails, without sweeping", async () => {
    // Nothing is going to run either way; a claim failure must degrade to a plain skip rather than
    // surface as a webhook error and earn a redelivery.
    vi.mocked(getPullRequestApproval).mockResolvedValue({ ok: true, approved: true });
    const env = createMockEnv();
    getControlPlaneFetch(env).mockResolvedValue(new Response("boom", { status: 500 }));
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_approved" });
    expect(
      getControlPlaneFetch(env).mock.calls.some(([url]) => /github-reviews\/sweep$/.test(url))
    ).toBe(false);
  });

  it("reviews as normal when the approval lookup fails", async () => {
    // Fail open: an unreadable approval state is not evidence of an approval.
    vi.mocked(getPullRequestApproval).mockResolvedValue({
      ok: false,
      error: "GitHub API returned 502",
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestReviewTriggerPayload = {
      ...pullRequestReviewTriggerPayload,
      action: "synchronize",
    };

    const result = await handlePullRequestReviewTrigger(env, log, payload, "trace-0");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "auto_review" });
  });

  it("does not look up approvals for a PR GitHub has just opened", async () => {
    // A brand-new PR cannot carry a review, so the call could only ever come back empty.
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestReviewTrigger(env, log, pullRequestReviewTriggerPayload, "trace-0");

    expect(getPullRequestApproval).not.toHaveBeenCalled();
  });

  it("returns early when autoReviewOnOpen is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-0"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-0"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("fail-closed config skips auto-review (autoReviewOnOpen: false)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
      enabledRepos: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("uses config.model instead of env.DEFAULT_MODEL", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestReviewTrigger(env, log, pullRequestReviewTriggerPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
  });

  it("passes reasoningEffort from config to session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestReviewTrigger(env, log, pullRequestReviewTriggerPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.reasoningEffort).toBe("high");
  });

  it("skips when the live PR head sha no longer matches the webhook payload", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "def456",
      state: "open",
      draft: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-stale"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "stale_head_sha" });
    // Target resolution may already have hit the control plane; the contract
    // is that a stale snapshot never claims a generation or creates a session.
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/internal/github-reviews/claim",
      expect.anything()
    );
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
    expect(log.debug).toHaveBeenCalledWith("handler.stale_head_sha", expect.anything());
  });

  it("returns skipped superseded when session creation loses the generation race (409)", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
        );
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "review generation superseded" }), { status: 409 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-superseded"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "superseded" });
    expect(postCommitStatus).not.toHaveBeenCalled();
  });

  it("still returns processed when the stale-review sweep fails", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      if (url === "https://internal/internal/github-reviews/claim") {
        return Promise.resolve(new Response(JSON.stringify({ generation: 2 }), { status: 200 }));
      }
      if (url === "https://internal/internal/github-reviews/sweep") {
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      }
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
        );
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
            status: 200,
          })
        );
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-sweep-fail"
    );

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "review_sweep.request_failed",
      expect.objectContaining({ status: 500 })
    );
  });
});

describe("handleReviewRequested", () => {
  it("creates session, posts reaction, and sends prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review",
    });
    expect(generateInstallationToken).toHaveBeenCalledWith({
      appId: "12345",
      privateKey: "test-key",
      installationId: "67890",
      userAgent: "Open-Inspect",
    });

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(5);

    // Verify session creation
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    // Verify prompt sending
    const promptBody = findCallBody(cpFetch, /^https:\/\/internal\/sessions\/session-123\/prompt$/);
    expect(promptBody.source).toBe("github");
    expect(promptBody).not.toHaveProperty("authorId");
    expect(promptBody.content).toContain("Pull Request #42");
    expect(promptBody.content).toContain("acme/widgets");
    expect(promptBody.content).toContain("gh pr diff 42");
    expect(promptBody.callbackContext).toEqual({
      source: "github",
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: "abc123",
    });

    // Verify logging
    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({
        session_id: "session-123",
        action: "review",
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "prompt.sent",
      expect.objectContaining({
        session_id: "session-123",
        message_id: "msg-456",
      })
    );
  });

  it("encodes nested repository owners in the reaction URL", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = {
      ...reviewRequestedPayload,
      repository: {
        ...reviewRequestedPayload.repository,
        owner: { login: "group/platform" },
      },
    };

    await handleReviewRequested(env, log, payload, "trace-nested-owner");

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/group%2Fplatform/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );
  });

  it("posts pending, then closes out through the lease, when prompt delivery fails", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
        );
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
            status: 200,
          })
        );
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(new Response("Unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    await expect(
      handleReviewRequested(env, createMockLogger(), reviewRequestedPayload, "trace-review-failed")
    ).rejects.toThrow("Prompt delivery failed: 503 Unavailable");

    expect(postCommitStatus).toHaveBeenNthCalledWith(
      1,
      "test-installation-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "pending",
        context: "open-inspect",
        description: "Review in progress",
      },
      "Open-Inspect"
    );
    expect(postCommitStatus).toHaveBeenLastCalledWith(
      "test-installation-token",
      "acme",
      "widgets",
      "abc123",
      {
        state: "error",
        context: "open-inspect",
        description: "Review failed to start",
      },
      "Open-Inspect"
    );
    expect(controlPlaneBodies(cpFetch, CLOSE_OUT_URL)).toEqual([
      {
        sessionId: "session-123",
        request: { owner: "acme", repo: "widgets", description: "Review failed to start" },
      },
    ]);
  });

  it("returns early if reviewer is not the bot", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.review_not_for_bot", expect.anything());
  });

  it("accepts a request aimed at the reviewer App's login when one is configured", async () => {
    const env = { ...createMockEnv(), GITHUB_REVIEWER_USERNAME: "test-reviewer[bot]" } as Env;
    const log = createMockLogger();
    const payload = {
      ...reviewRequestedPayload,
      requested_reviewer: { login: "test-reviewer[bot]" },
    };

    const result = await handleReviewRequested(env, log, payload, "trace-reviewer-login");

    expect(result).not.toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).toHaveBeenCalled();
  });

  it("still rejects the reviewer App's login when none is configured", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = {
      ...reviewRequestedPayload,
      requested_reviewer: { login: "test-reviewer[bot]" },
    };

    const result = await handleReviewRequested(env, log, payload, "trace-no-reviewer-login");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
  });

  it("returns early if no reviewer specified", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: undefined };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("skips when the live PR head sha no longer matches the webhook payload", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "def456",
      state: "open",
      draft: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-stale");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "stale_head_sha" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/internal/github-reviews/claim",
      expect.anything()
    );
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
    expect(log.debug).toHaveBeenCalledWith("handler.stale_head_sha", expect.anything());
  });

  it("honors an explicit review request while the PR is still a draft", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "abc123",
      state: "open",
      draft: true,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-draft");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review",
    });
    expect(getControlPlaneFetch(env)).toHaveBeenCalledWith(
      "https://internal/internal/github-reviews/claim",
      expect.anything()
    );
  });

  it("skips when the PR has already closed by the time of the freshness check", async () => {
    vi.mocked(getPullRequestSnapshot).mockResolvedValue({
      ok: true,
      headSha: "abc123",
      state: "closed",
      draft: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-closed");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "stale_head_sha" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/internal/github-reviews/claim",
      expect.anything()
    );
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });
});

describe("handleIssueComment", () => {
  it("creates session and sends prompt for PR comment with @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(3);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.scmLogin).toBe("bob");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1002");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@test-bot[bot]");
    expect(promptBody).not.toHaveProperty("authorId");
  });

  it("returns early if not a PR", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      issue: { number: 42, title: "Bug report", pull_request: undefined },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "not_a_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.not_a_pr", expect.anything());
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: { ...issueCommentPayload.comment, body: "just a regular comment" },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("does not treat a longer username prefix as an @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "Please ask @test-bot[bot]-clone to handle this.",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_comment" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.self_comment_ignored", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleReviewComment", () => {
  it("creates session and sends prompt with file context", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review_comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/comments/200/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.scmLogin).toBe("carol");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1003");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("src/cache.ts");
    expect(promptBody.content).toContain("const cache = new Map()");
    expect(promptBody.content).toContain("comments/200/replies");
    expect(promptBody).not.toHaveProperty("authorId");
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "just a comment" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_comment" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("error handling", () => {
  it("throws when the control plane is unreachable (fails at the claim step)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    let finishReaction!: (ok: boolean) => void;
    vi.mocked(postReaction).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishReaction = resolve;
      })
    );
    getControlPlaneFetch(env).mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const handlerPromise = handleReviewRequested(env, log, reviewRequestedPayload, "trace-err");
    let handlerSettled = false;
    void handlerPromise
      .finally(() => {
        handlerSettled = true;
      })
      .catch(() => {});
    await vi.waitFor(() => expect(getControlPlaneFetch(env)).toHaveBeenCalled());
    expect(handlerSettled).toBe(false);

    finishReaction(true);
    await expect(handlerPromise).rejects.toThrow("Review generation claim failed: 500");
  });

  it("proceeds with session even if reaction fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(postReaction).mockResolvedValue(false);

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-reaction");

    // Session should still be created despite reaction failure
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(5);
    expect(log.warn).toHaveBeenCalledWith("acknowledgment.failed", expect.any(Object));
  });
});

describe("integration config", () => {
  it("fetches config with the correct repo and logger", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-config");

    expect(getGitHubConfig).toHaveBeenCalledWith(env, "acme/widgets", log);
  });

  it("uses config.model in session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "low",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-model");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
    expect(sessionBody.reasoningEffort).toBe("low");
  });

  it("fail-closed config skips webhook (empty enabledRepos)", async () => {
    // Fail-closed defaults (enabledRepos: [], autoReviewOnOpen: false) cause the
    // handler to return early — no session created, no webhook processed.
    vi.mocked(getGitHubConfig).mockResolvedValue({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(
      env,
      log,
      reviewRequestedPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    // No session should have been created
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("null enabledRepos (no settings configured) allows all repos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: null,
      model: "anthropic/claude-haiku-4-5",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null");

    // Should proceed normally — null means all repos allowed
    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(5);
  });

  it("rejects sender not in allowedTriggerUsers (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-allowlist");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    // bob is the sender, not in ["alice"] → rejected before token generation
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "bob" })
    );
  });

  it("allows sender in allowedTriggerUsers (case-insensitive)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["BoB"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-allowed");

    // bob matches → proceeds to session creation
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(3);
  });

  it("empty allowedTriggerUsers rejects all senders (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: [],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-empty");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("rejects sender when permission check fails (no allowlist)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-noperm");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
    // Token generated (needed for permission check), but no session created
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_insufficient_permission",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("logs permission_check_failed when permission API returns error", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false, error: true });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-apierr");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "permission_check_failed" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.permission_check_failed",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("handlePullRequestReviewTrigger rejects sender not in allowedTriggerUsers", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["someone-else"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-pr-gating"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("config fetch called after cheap early exit (not-for-bot)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    const result = await handleReviewRequested(env, log, payload, "trace-early");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    // Config fetch should NOT happen for cheap early exits
    expect(getGitHubConfig).not.toHaveBeenCalled();
  });

  it("codeReviewInstructions flows into review prompt (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Focus on security.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-review-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Focus on security.");
  });

  it("commentActionInstructions flows into comment prompt (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Run tests first.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-comment-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Run tests first.");
  });

  it("codeReviewInstructions flows into review prompt (handlePullRequestReviewTrigger)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Check for SQL injection.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-pr-instr"
    );

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Check for SQL injection.");
  });

  it("commentActionInstructions flows into comment prompt (handleReviewComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Prefer minimal diffs.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewComment(env, log, reviewCommentPayload, "trace-rc-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Prefer minimal diffs.");
  });

  it("null instructions produce no Custom Instructions section (backward compat)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).not.toContain("## Custom Instructions");
  });
});

describe("default environment targets", () => {
  const fullstackEnvironment = {
    id: "env_abc",
    name: "Fullstack",
    repositories: [
      { repoOwner: "acme", repoName: "widgets" },
      { repoOwner: "acme", repoName: "gadgets" },
    ],
  };

  /**
   * Point the metadata lookup at a default environment and control what the
   * environment fetch returns (null → 404, as for a deleted environment).
   */
  function mockSessionTarget(
    env: Env,
    opts: {
      metadata?: { defaultEnvironmentId?: string } | null;
      metadataStatus?: number;
      environment?: typeof fullstackEnvironment | null;
    }
  ) {
    getControlPlaneFetch(env).mockImplementation((url: string) => {
      const supersession = defaultReviewSupersessionResponse(url);
      if (supersession) return Promise.resolve(supersession);
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        if (opts.metadataStatus) {
          return Promise.resolve(new Response("Error", { status: opts.metadataStatus }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: opts.metadata ?? null }), {
            status: 200,
          })
        );
      }
      if (/^https:\/\/internal\/environments\//.test(url)) {
        return opts.environment
          ? Promise.resolve(
              new Response(JSON.stringify({ environment: opts.environment }), { status: 200 })
            )
          : Promise.resolve(new Response("Not found", { status: 404 }));
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
            status: 200,
          })
        );
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
  }

  it("launches the default environment when it contains the trigger repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env");

    expect(result).toMatchObject({ outcome: "processed", session_id: "session-123" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
    expect(sessionBody.repoOwner).toBeUndefined();
    expect(sessionBody.repoName).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "target.environment_selected",
      expect.objectContaining({ environment_id: "env_abc", repo: "acme/widgets" })
    );
    // Sender permission is verified on the environment's other repository
    // (the trigger repo was already checked by caller gating).
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "test-installation-token",
      "acme",
      "gadgets",
      "alice",
      expect.any(String)
    );
  });

  it("falls back to the repo when the sender lacks permission on another environment repo", async () => {
    vi.mocked(checkSenderPermission).mockImplementation(async (_token, _owner, repo) => ({
      hasPermission: repo !== "gadgets",
    }));
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-authz");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_sender_not_authorized",
      expect.objectContaining({
        environment_id: "env_abc",
        denied_repo: "acme/gadgets",
        sender: "alice",
      })
    );
  });

  it("falls back to the repo when a sender permission check errors", async () => {
    vi.mocked(checkSenderPermission).mockImplementation(async (_token, _owner, repo) =>
      repo === "gadgets" ? { hasPermission: false, error: true } : { hasPermission: true }
    );
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-err");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_sender_not_authorized",
      expect.objectContaining({ denied_repo: "acme/gadgets", permission_check_error: true })
    );
  });

  it("allowlisted senders launch environments without per-repo permission checks", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-al");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
    // Allowlist mode never consults GitHub repo permissions — for the trigger
    // repo or the environment's repositories.
    expect(checkSenderPermission).not.toHaveBeenCalled();
  });

  it("falls back to the repo when the environment no longer exists", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_gone" },
      environment: null,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-gone");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_not_found",
      expect.objectContaining({ environment_id: "env_gone" })
    );
  });

  it("falls back to the repo when the environment lacks the trigger repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: {
        ...fullstackEnvironment,
        repositories: [{ repoOwner: "acme", repoName: "gadgets" }],
      },
    });

    const result = await handlePullRequestReviewTrigger(
      env,
      log,
      pullRequestReviewTriggerPayload,
      "trace-env-nm"
    );

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_missing_trigger_repo",
      expect.objectContaining({ environment_id: "env_abc", repo: "acme/widgets" })
    );
  });

  it("falls back to the repo when the metadata lookup fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, { metadataStatus: 500 });

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-env-meta");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.metadata_fetch_failed",
      expect.objectContaining({ repo: "acme/widgets", status: 500 })
    );
  });

  it("membership check is case-insensitive", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: {
        ...fullstackEnvironment,
        repositories: [{ repoOwner: "ACME", repoName: "Widgets" }],
      },
    });

    await handleReviewComment(env, log, reviewCommentPayload, "trace-env-case");

    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
  });
});
