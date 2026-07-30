import { describe, expect, it } from "vitest";
import { githubReviewPublicationRequestSchema } from "./github-autofix";

describe("githubReviewPublicationRequestSchema", () => {
  it("rejects a no-findings changes-request review", () => {
    expect(
      githubReviewPublicationRequestSchema.safeParse({
        event: "REQUEST_CHANGES",
        summary: "No findings.",
        result: "no_findings",
        comments: [],
      }).success
    ).toBe(false);
  });

  it("accepts no-findings comment and approval reviews", () => {
    for (const event of ["COMMENT", "APPROVE"] as const) {
      expect(
        githubReviewPublicationRequestSchema.safeParse({
          event,
          summary: "No findings.",
          result: "no_findings",
          comments: [],
        }).success
      ).toBe(true);
    }
  });
});
