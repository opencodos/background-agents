import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";

vi.mock("./auth/github-app", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
    getCachedInstallationToken: vi.fn(),
  };
});

import { fetchWithTimeout, getCachedInstallationToken } from "./auth/github-app";

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);
const mockGetCachedInstallationToken = vi.mocked(getCachedInstallationToken);

function createEnv(publication?: Record<string, unknown>) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => publication ?? null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  };
  return {
    ...TEST_SERVICE_SECRETS,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_BOT_USERNAME: "open-inspect[bot]",
    DEPLOYMENT_NAME: "test",
    REPOS_CACHE: {},
    AUTOFIX_QUEUE: { send: vi.fn(async () => undefined) },
    _statement: statement,
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]),
      exec: vi.fn(),
      dump: vi.fn(),
    },
  };
}

describe("Autofix operator routes", () => {
  it("allows the signed web service to read deployment activity", async () => {
    const response = await handleRequest(
      await signedServiceRequest("https://test.local/autofix/activity", {
        service: "web",
      }),
      createEnv() as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ records: [], nextCursor: null });
  });

  it("rejects another authenticated service from deployment activity", async () => {
    const response = await handleRequest(
      await signedServiceRequest("https://test.local/autofix/activity", {
        service: "github-bot",
      }),
      createEnv() as never
    );

    expect(response.status).toBe(401);
  });

  it("allows the signed web service to reconcile a review publication", async () => {
    const response = await handleRequest(
      await signedServiceRequest(
        "https://test.local/autofix/review-publications/publication-1/reconcile",
        {
          method: "POST",
          body: JSON.stringify({ action: "search" }),
          service: "web",
        }
      ),
      createEnv() as never
    );

    expect(response.status).toBe(404);
  });

  it("rejects another authenticated service from review reconciliation", async () => {
    const response = await handleRequest(
      await signedServiceRequest(
        "https://test.local/autofix/review-publications/publication-1/reconcile",
        {
          method: "POST",
          body: JSON.stringify({ action: "search" }),
          service: "github-bot",
        }
      ),
      createEnv() as never
    );

    expect(response.status).toBe(401);
  });

  it("re-enqueues confirmed late feedback after reopening it", async () => {
    mockGetCachedInstallationToken.mockResolvedValueOnce("installation-token");
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        Response.json({
          id: 5678,
          body: "Review\n\n<!-- open-inspect-review:opaque -->",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
          user: { id: 9, login: "open-inspect[bot]", type: "Bot" },
        })
      )
      .mockResolvedValueOnce(Response.json([]));
    const env = createEnv({
      publication_key: "github-review:opaque",
      provider_review_id: null,
      repository_external_id: "99",
      repo_owner: "acme",
      repo_name: "widgets",
      pr_number: 42,
      head_sha: "abc123",
      source_session_id: "session-1",
      source_message_id: "message-1",
      result: "findings",
      state: "uncertain",
      marker: "<!-- open-inspect-review:opaque -->",
      error: "connection reset",
      created_at: 1_000,
      updated_at: 1_500,
    });

    const response = await handleRequest(
      await signedServiceRequest(
        "https://test.local/autofix/review-publications/github-review%3Aopaque/reconcile",
        {
          method: "POST",
          body: JSON.stringify({ action: "confirm", providerReviewId: "5678" }),
          service: "web",
        }
      ),
      env as never
    );

    expect(response.status).toBe(200);
    expect(env._statement.run).toHaveBeenCalledBefore(env.AUTOFIX_QUEUE.send);
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "reconcile:github-review:opaque",
        providerObject: { kind: "review", id: "5678" },
      })
    );
  });
});
