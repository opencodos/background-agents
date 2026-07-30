import { describe, expect, it } from "vitest";
import { isReviewReconciliationCandidate } from "./autofix";

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
});
