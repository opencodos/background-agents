import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubPullRequestFeedbackClient,
  GitHubReviewPublicationError,
} from "./github-pull-request-feedback-client";
import { SourceControlProviderError } from "./errors";

vi.mock("../auth/github-app", () => ({
  fetchWithTimeout: vi.fn(),
  getCachedInstallationToken: vi.fn(),
}));

import { fetchWithTimeout, getCachedInstallationToken } from "../auth/github-app";

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);
const mockGetCachedInstallationToken = vi.mocked(getCachedInstallationToken);
const appConfig = { appId: "123", privateKey: "fake-key", installationId: "456" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeReviewComment(index: number) {
  const id = 9_000 + index;
  return {
    id,
    body: `Comment ${index}`,
    html_url: `https://github.com/acme/web/pull/7#discussion_r${id}`,
    path: "src/input.ts",
    line: index + 1,
    start_line: null,
    side: "RIGHT",
    start_side: null,
    diff_hunk: "@@ -1 +1 @@",
  };
}

describe("GitHubPullRequestFeedbackClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedInstallationToken.mockResolvedValue("installation-token");
  });

  it("publishes the summary and inline findings in one submitted review", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      json({
        id: 5678,
        html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
      })
    );
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    const result = await client.publishPullRequestReview({
      owner: "acme",
      name: "widgets",
      pullRequestNumber: 42,
      headSha: "abc123",
      event: "REQUEST_CHANGES",
      body: "One issue.",
      comments: [
        {
          path: "src/widget.ts",
          line: 17,
          side: "RIGHT",
          body: "Handle null here.",
        },
      ],
    });

    expect(result.providerReviewId).toBe("5678");
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          commit_id: "abc123",
          event: "REQUEST_CHANGES",
          body: "One issue.",
          comments: [
            {
              path: "src/widget.ts",
              line: 17,
              side: "RIGHT",
              body: "Handle null here.",
            },
          ],
        }),
      })
    );
  });

  it.each([
    { status: 422, outcome: "definite" },
    { status: 503, outcome: "uncertain" },
  ] as const)("classifies HTTP $status publication failure as $outcome", async (example) => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response("rejected", { status: example.status })
    );
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    const error = await client
      .publishPullRequestReview({
        owner: "acme",
        name: "widgets",
        pullRequestNumber: 42,
        headSha: "abc123",
        event: "COMMENT",
        body: "Review",
        comments: [],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubReviewPublicationError);
    expect(error).toMatchObject({ outcome: example.outcome });
  });

  it("classifies a transport error as an uncertain publication outcome", async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error("connection reset"));
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    const error = await client
      .publishPullRequestReview({
        owner: "acme",
        name: "widgets",
        pullRequestNumber: 42,
        headSha: "abc123",
        event: "COMMENT",
        body: "Review",
        comments: [],
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ outcome: "uncertain" });
  });

  it("finds marker candidates without treating them as confirmed receipts", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      json([
        {
          id: 5678,
          body: "Review\n\n<!-- open-inspect-review:opaque -->",
          html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
          state: "COMMENTED",
          user: { id: 9, login: "open-inspect[bot]", type: "Bot" },
        },
        {
          id: 5679,
          body: "Unrelated review",
          html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5679",
          state: "COMMENTED",
          user: { id: 10, login: "alice", type: "User" },
        },
      ])
    );
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    await expect(
      client.findPullRequestReviewsByMarker({
        owner: "acme",
        name: "widgets",
        pullRequestNumber: 42,
        marker: "<!-- open-inspect-review:opaque -->",
      })
    ).resolves.toEqual([
      {
        providerReviewId: "5678",
        authorLogin: "open-inspect[bot]",
        url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
      },
    ]);
  });

  it("reads a pull request conversation comment authoritatively", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      json({
        id: 1234,
        body: "Please handle the null case.",
        html_url: "https://github.com/acme/web/pull/7#issuecomment-1234",
        issue_url: "https://api.github.com/repos/acme/web/issues/7",
        user: { id: 77, login: "alice", type: "User" },
      })
    );
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    await expect(
      client.getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "pr_comment", id: "1234" },
      })
    ).resolves.toEqual({
      kind: "pr_comment",
      id: "1234",
      body: "Please handle the null case.",
      url: "https://github.com/acme/web/pull/7#issuecomment-1234",
      author: { id: "77", login: "alice", type: "User" },
    });
  });

  it("reads one submitted review with all of its inline comments", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        json({
          id: 5678,
          body: "One issue.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(
        json([
          {
            id: 9001,
            body: "Handle null here.",
            html_url: "https://github.com/acme/web/pull/7#discussion_r9001",
            path: "src/input.ts",
            line: 12,
            start_line: null,
            side: "RIGHT",
            start_side: null,
            diff_hunk: "@@ -10,2 +10,3 @@",
          },
        ])
      );
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    await expect(
      client.getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "review", id: "5678" },
      })
    ).resolves.toMatchObject({
      kind: "review",
      id: "5678",
      comments: [{ id: "9001", path: "src/input.ts", line: 12 }],
    });
  });

  it("fetches the next review-comment page when the first page is full", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        json({
          id: 5678,
          body: "Large review.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(
        json(Array.from({ length: 100 }, (_, index) => makeReviewComment(index)))
      )
      .mockResolvedValueOnce(json([]));
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    const feedback = await client.getPullRequestFeedback({
      owner: "acme",
      name: "web",
      pullRequestNumber: 7,
      providerObject: { kind: "review", id: "5678" },
    });

    expect(feedback.kind === "review" ? feedback.comments : []).toHaveLength(100);
    expect(mockFetchWithTimeout).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/acme/web/pulls/7/reviews/5678/comments?per_page=100&page=2",
      expect.anything()
    );
  });

  it("rejects an oversized review instead of dispatching partial feedback", async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        json({
          id: 5678,
          body: "Oversized review.",
          state: "CHANGES_REQUESTED",
          html_url: "https://github.com/acme/web/pull/7#pullrequestreview-5678",
          user: { id: 77, login: "alice", type: "User" },
        })
      )
      .mockResolvedValueOnce(
        json(Array.from({ length: 100 }, (_, index) => makeReviewComment(index)))
      )
      .mockResolvedValueOnce(json([makeReviewComment(100)]));
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    const error = await client
      .getPullRequestFeedback({
        owner: "acme",
        name: "web",
        pullRequestNumber: 7,
        providerObject: { kind: "review", id: "5678" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceControlProviderError);
    expect((error as SourceControlProviderError).errorType).toBe("permanent");
    expect((error as Error).message).toContain("100");
  });

  it.each(["write", "maintain", "admin"] as const)(
    "accepts GitHub %s permission",
    async (permission) => {
      mockFetchWithTimeout.mockResolvedValueOnce(json({ permission }));
      const client = new GitHubPullRequestFeedbackClient({ appConfig });

      await expect(
        client.hasPullRequestWritePermission({
          owner: "acme",
          name: "web",
          authorLogin: "alice",
        })
      ).resolves.toBe(true);
    }
  );

  it.each(["none", "read", "triage"] as const)(
    "rejects GitHub %s permission",
    async (permission) => {
      mockFetchWithTimeout.mockResolvedValueOnce(json({ permission }));
      const client = new GitHubPullRequestFeedbackClient({ appConfig });

      await expect(
        client.hasPullRequestWritePermission({
          owner: "acme",
          name: "web",
          authorLogin: "alice",
        })
      ).resolves.toBe(false);
    }
  );

  it("treats a missing collaborator as lacking write permission", async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
    const client = new GitHubPullRequestFeedbackClient({ appConfig });

    await expect(
      client.hasPullRequestWritePermission({
        owner: "acme",
        name: "web",
        authorLogin: "alice",
      })
    ).resolves.toBe(false);
  });
});
