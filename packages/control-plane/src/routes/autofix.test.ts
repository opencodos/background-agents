import { describe, expect, it } from "vitest";
import type { GitHubReviewPublicationRecord } from "../db/github-review-publication-store";
import {
  buildReconciledReviewEnvelope,
  ownedReviewCandidates,
  isReviewReconciliationCandidate,
} from "./autofix";

describe("review publication reconciliation", () => {
  const publication = { marker: "<!-- open-inspect-review:opaque -->" };

  it("requires both the bound marker and the deployment App identity", () => {
    expect(
      isReviewReconciliationCandidate(
        publication,
        {
          kind: "review",
          body: `Review\n\n${publication.marker}`,
          author: { login: "open-inspect[bot]" },
        },
        "Open-Inspect[bot]"
      )
    ).toBe(true);
  });

  it("does not trust a copied marker from another author", () => {
    expect(
      isReviewReconciliationCandidate(
        publication,
        {
          kind: "review",
          body: `Copied\n\n${publication.marker}`,
          author: { login: "attacker" },
        },
        "open-inspect[bot]"
      )
    ).toBe(false);
  });

  it("uses the same App identity rule when listing marker candidates", () => {
    expect(
      ownedReviewCandidates(
        publication,
        [
          {
            providerReviewId: "copied",
            authorLogin: "attacker",
            url: "https://github.com/acme/widgets/pull/42#pullrequestreview-copied",
            body: `Copied\n\n${publication.marker}`,
          },
          {
            providerReviewId: "owned",
            authorLogin: "open-inspect[bot]",
            url: "https://github.com/acme/widgets/pull/42#pullrequestreview-owned",
            body: `Review\n\n${publication.marker}`,
          },
        ],
        "Open-Inspect[bot]"
      )
    ).toEqual([
      {
        providerReviewId: "owned",
        authorLogin: "open-inspect[bot]",
        url: "https://github.com/acme/widgets/pull/42#pullrequestreview-owned",
      },
    ]);
  });

  it("builds an idempotent queue envelope for confirmed late feedback", () => {
    const record = {
      publicationKey: "github-review:opaque",
      repositoryExternalId: "99",
      repoOwner: "acme",
      repoName: "widgets",
      prNumber: 42,
    } as GitHubReviewPublicationRecord;

    expect(buildReconciledReviewEnvelope(record, "5678", 2_000)).toEqual({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      reconciliationPublicationKey: "github-review:opaque",
      deliveryId: "reconcile:github-review:opaque",
      traceId: "reconcile:github-review:opaque",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: new Date(2_000).toISOString(),
    });
  });
});
