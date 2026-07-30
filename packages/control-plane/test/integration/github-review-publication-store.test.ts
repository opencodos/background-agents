import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { GitHubReviewPublicationStore } from "../../src/db/github-review-publication-store";
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
});
