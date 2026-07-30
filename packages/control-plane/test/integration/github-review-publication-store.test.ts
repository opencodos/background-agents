import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { GitHubReviewPublicationStore } from "../../src/db/github-review-publication-store";
import { PrAutofixFeedbackStore } from "../../src/db/pr-autofix-feedback-store";
import { cleanD1Tables } from "./cleanup";

const publication = {
  publicationKey: "github-review:opaque",
  repositoryExternalId: "99",
  repoOwner: "acme",
  repoName: "widgets",
  prNumber: 42,
  headSha: "abc123",
  sourceSessionId: "session-1",
  sourceMessageId: "message-1",
  result: "findings" as const,
  marker: "<!-- open-inspect-review:opaque -->",
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe("GitHubReviewPublicationStore", () => {
  beforeEach(cleanD1Tables);

  it("admits one pending publication per source message", async () => {
    const store = new GitHubReviewPublicationStore(env.DB);

    const first = await store.begin(publication);
    const duplicate = await store.begin(publication);

    expect(first).toMatchObject({ created: true, record: { state: "pending" } });
    expect(duplicate).toMatchObject({ created: false, record: { state: "pending" } });
  });

  it("records a completed provider review and finds it by provider identity", async () => {
    const store = new GitHubReviewPublicationStore(env.DB);
    await store.begin(publication);

    await store.complete(publication.publicationKey, "5678", 2_000);

    expect(await store.getByProviderReviewId("5678")).toMatchObject({
      publicationKey: publication.publicationKey,
      providerReviewId: "5678",
      state: "completed",
      result: "findings",
      updatedAt: 2_000,
    });
  });

  it("never automatically transitions an uncertain receipt back to pending", async () => {
    const store = new GitHubReviewPublicationStore(env.DB);
    await store.begin(publication);
    await store.markUncertain(publication.publicationKey, "connection reset", 2_000);

    const duplicate = await store.begin(publication);

    expect(duplicate).toMatchObject({
      created: false,
      record: { state: "uncertain", error: "connection reset" },
    });
  });

  it("reopens a definite failed publication for one safe retry", async () => {
    const store = new GitHubReviewPublicationStore(env.DB);
    await store.begin(publication);
    await store.fail(publication.publicationKey, "invalid line", 2_000);

    const corrected = {
      ...publication,
      headSha: "def456",
      result: "no_findings" as const,
      updatedAt: 3_000,
    };
    const retried = await store.begin(corrected);
    const concurrent = await store.begin(corrected);

    expect(retried).toMatchObject({
      created: true,
      record: {
        state: "pending",
        error: null,
        headSha: "def456",
        result: "no_findings",
        updatedAt: 3_000,
      },
    });
    expect(concurrent).toMatchObject({
      created: false,
      record: { state: "pending" },
    });
  });

  it("reopens unattributed feedback only when the confirmed queue message is received", async () => {
    const publications = new GitHubReviewPublicationStore(env.DB);
    const feedback = new PrAutofixFeedbackStore(env.DB);
    await publications.begin(publication);
    const receipt = await feedback.receive(
      {
        version: 1,
        eventType: "pull_request_review",
        action: "submitted",
        deliveryId: "delivery-review",
        traceId: "trace-review",
        providerObject: { kind: "review", id: "5678" },
        repository: { id: "99", owner: "acme", name: "widgets" },
        pullRequestNumber: 42,
        receivedAt: "2026-07-30T05:00:00.000Z",
      },
      1_000
    );
    await feedback.markSkipped(receipt.feedbackKey, "own_app_unattributed", 1_500);

    await publications.reconcileComplete(publication.publicationKey, "5678", 2_000);
    await publications.reconcileComplete(publication.publicationKey, "5678", 2_500);

    expect(await publications.get(publication.publicationKey)).toMatchObject({
      state: "completed",
      providerReviewId: "5678",
    });
    expect(await feedback.get(receipt.feedbackKey)).toMatchObject({
      decision: "skipped",
      reason: "own_app_unattributed",
    });

    await feedback.receive(
      {
        version: 1,
        eventType: "pull_request_review",
        action: "submitted",
        reconciliationPublicationKey: "github-review:wrong",
        deliveryId: "reconcile:github-review:wrong",
        traceId: "reconcile:github-review:wrong",
        providerObject: { kind: "review", id: "5678" },
        repository: { id: "99", owner: "acme", name: "widgets" },
        pullRequestNumber: 42,
        receivedAt: "2026-07-30T05:01:00.000Z",
      },
      2_500
    );
    expect(await feedback.get(receipt.feedbackKey)).toMatchObject({
      decision: "skipped",
      reason: "own_app_unattributed",
    });

    await feedback.receive(
      {
        version: 1,
        eventType: "pull_request_review",
        action: "submitted",
        reconciliationPublicationKey: publication.publicationKey,
        deliveryId: "reconcile:github-review:opaque",
        traceId: "reconcile:github-review:opaque",
        providerObject: { kind: "review", id: "5678" },
        repository: { id: "99", owner: "acme", name: "widgets" },
        pullRequestNumber: 42,
        receivedAt: "2026-07-30T05:01:00.000Z",
      },
      2_500
    );

    expect(await feedback.get(receipt.feedbackKey)).toMatchObject({
      decision: "received",
      reason: null,
    });
  });

  it("allows an operator to abandon a pending or uncertain publication", async () => {
    const store = new GitHubReviewPublicationStore(env.DB);
    await store.begin(publication);

    await store.abandon(publication.publicationKey, 2_000);

    expect(await store.get(publication.publicationKey)).toMatchObject({
      state: "failed",
      error: "operator_confirmed_absent",
      updatedAt: 2_000,
    });
  });
});
