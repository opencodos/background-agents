import { describe, expect, it, vi } from "vitest";
import type { GitHubReviewPublicationRecord } from "../db/github-review-publication-store";
import type { GitHubReviewPublicationAttempt } from "../source-control/github-pull-request-feedback-client";
import { GitHubReviewPublisher } from "./review-publisher";

const request = {
  event: "REQUEST_CHANGES" as const,
  summary: "One blocking issue.",
  result: "findings" as const,
  comments: [
    {
      path: "src/widget.ts",
      line: 17,
      side: "RIGHT" as const,
      body: "Handle null here.",
    },
  ],
};

function buildPublisher() {
  const pending: GitHubReviewPublicationRecord = {
    publicationKey: "github-review:opaque",
    providerReviewId: null,
    repositoryExternalId: "99",
    repoOwner: "acme",
    repoName: "widgets",
    prNumber: 42,
    headSha: "abc123",
    sourceSessionId: "session-1",
    sourceMessageId: "msg-1",
    result: "findings" as const,
    state: "pending" as const,
    marker: "<!-- open-inspect-review:opaque -->",
    error: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const publications = {
    begin: vi.fn(async () => ({ record: pending, created: true })),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    markUncertain: vi.fn(async () => undefined),
  };
  const sessions = {
    fetch: vi.fn(async () =>
      Response.json({
        sourceMessageId: "msg-1",
        target: {
          kind: "github_review_request",
          repositoryId: "99",
          repositoryOwner: "acme",
          repositoryName: "widgets",
          pullRequestNumber: 42,
          headSha: "abc123",
        },
      })
    ),
  };
  const github = {
    publishPullRequestReview: vi.fn(
      async (): Promise<GitHubReviewPublicationAttempt> => ({
        kind: "published",
        providerReviewId: "5678",
        url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
      })
    ),
  };
  const publisher = new GitHubReviewPublisher({
    publications,
    sessions,
    github,
    now: () => 1_000,
    digest: async () => "opaque",
  });
  return { publisher, publications, sessions, github, pending };
}

describe("GitHubReviewPublisher", () => {
  it("writes pending before making exactly one provider review call", async () => {
    const h = buildPublisher();

    const result = await h.publisher.publish("session-1", request);

    expect(h.publications.begin).toHaveBeenCalledBefore(h.github.publishPullRequestReview);
    expect(h.github.publishPullRequestReview).toHaveBeenCalledOnce();
    expect(h.github.publishPullRequestReview).toHaveBeenCalledWith({
      owner: "acme",
      name: "widgets",
      pullRequestNumber: 42,
      headSha: "abc123",
      event: "REQUEST_CHANGES",
      body: "One blocking issue.\n\n<!-- open-inspect-review:opaque -->",
      comments: request.comments,
    });
    expect(h.publications.complete).toHaveBeenCalledWith("github-review:opaque", "5678", 1_000);
    expect(result).toEqual({
      publicationKey: "github-review:opaque",
      state: "completed",
      providerReviewId: "5678",
    });
  });

  it("does not repost when the source message already has a receipt", async () => {
    const h = buildPublisher();
    h.publications.begin.mockResolvedValueOnce({
      record: { ...h.pending, state: "uncertain" },
      created: false,
    });

    const result = await h.publisher.publish("session-1", request);

    expect(result.state).toBe("uncertain");
    expect(h.github.publishPullRequestReview).not.toHaveBeenCalled();
  });

  it("records a known provider rejection as failed", async () => {
    const h = buildPublisher();
    h.github.publishPullRequestReview.mockResolvedValueOnce({
      kind: "rejected",
      outcome: "definite",
      error: "invalid line",
    });

    await expect(h.publisher.publish("session-1", request)).rejects.toThrow("invalid line");

    expect(h.publications.fail).toHaveBeenCalledWith("github-review:opaque", "invalid line", 1_000);
    expect(h.publications.markUncertain).not.toHaveBeenCalled();
  });

  it("records an unknown provider outcome as uncertain and never retries", async () => {
    const h = buildPublisher();
    h.github.publishPullRequestReview.mockResolvedValueOnce({
      kind: "rejected",
      outcome: "uncertain",
      error: "connection reset",
    });

    await expect(h.publisher.publish("session-1", request)).rejects.toThrow("connection reset");

    expect(h.publications.markUncertain).toHaveBeenCalledWith(
      "github-review:opaque",
      "connection reset",
      1_000
    );
    expect(h.publications.fail).not.toHaveBeenCalled();
  });

  it("rejects publication if the SessionDO has no processing review request", async () => {
    const h = buildPublisher();
    h.sessions.fetch.mockResolvedValueOnce(
      Response.json({ error: "No review request is currently processing" }, { status: 409 })
    );

    await expect(h.publisher.publish("session-1", request)).rejects.toThrow(
      "No review request is currently processing"
    );

    expect(h.publications.begin).not.toHaveBeenCalled();
    expect(h.github.publishPullRequestReview).not.toHaveBeenCalled();
  });
});
