import {
  githubReviewTargetOriginSchema,
  type GitHubReviewPublicationRequest,
  type GitHubReviewPublicationResponse,
} from "@open-inspect/shared";
import { z } from "zod";
import type { GitHubReviewPublicationRecord } from "../db/github-review-publication-store";
import { GitHubReviewPublicationError } from "../source-control/providers/github-provider";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";

const publicationContextSchema = z.object({
  sourceMessageId: z.string().min(1),
  target: githubReviewTargetOriginSchema,
});

interface PublicationStore {
  begin(
    record: Omit<GitHubReviewPublicationRecord, "providerReviewId" | "state" | "error">
  ): Promise<{ record: GitHubReviewPublicationRecord; created: boolean }>;
  complete(publicationKey: string, providerReviewId: string, updatedAt: number): Promise<unknown>;
  fail(publicationKey: string, error: string, updatedAt: number): Promise<unknown>;
  markUncertain(publicationKey: string, error: string, updatedAt: number): Promise<unknown>;
}

interface ReviewProvider {
  publishPullRequestReview(config: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    headSha: string;
    event: GitHubReviewPublicationRequest["event"];
    body: string;
    comments: GitHubReviewPublicationRequest["comments"];
  }): Promise<{ providerReviewId: string; url: string }>;
}

interface ReviewPublisherDeps {
  publications: PublicationStore;
  sessions: SessionRuntimeClient;
  github: ReviewProvider;
  now: () => number;
  digest?: (value: string) => Promise<string>;
}

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function responseFor(record: GitHubReviewPublicationRecord): GitHubReviewPublicationResponse {
  return {
    publicationKey: record.publicationKey,
    state: record.state,
    providerReviewId: record.providerReviewId,
  };
}

export class GitHubReviewPublisher {
  constructor(private readonly deps: ReviewPublisherDeps) {}

  async publish(
    sourceSessionId: string,
    request: GitHubReviewPublicationRequest
  ): Promise<GitHubReviewPublicationResponse> {
    const contextResponse = await this.deps.sessions.fetch(
      sourceSessionId,
      SessionInternalPaths.githubReviewPublicationContext
    );
    if (!contextResponse.ok) {
      const errorBody = (await contextResponse.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new Error(
        typeof errorBody?.error === "string"
          ? errorBody.error
          : `Review publication context failed with status ${contextResponse.status}`
      );
    }
    const context = publicationContextSchema.safeParse(await contextResponse.json());
    if (!context.success) {
      throw new Error("Session returned invalid review publication context");
    }

    const opaque = await (this.deps.digest ?? sha256Prefix)(
      `${sourceSessionId}\0${context.data.sourceMessageId}`
    );
    const publicationKey = `github-review:${opaque}`;
    const marker = `<!-- open-inspect-review:${opaque} -->`;
    const now = this.deps.now();
    const begun = await this.deps.publications.begin({
      publicationKey,
      repositoryExternalId: context.data.target.repositoryId,
      repoOwner: context.data.target.repositoryOwner,
      repoName: context.data.target.repositoryName,
      prNumber: context.data.target.pullRequestNumber,
      headSha: context.data.target.headSha,
      sourceSessionId,
      sourceMessageId: context.data.sourceMessageId,
      result: request.result,
      marker,
      createdAt: now,
      updatedAt: now,
    });
    if (!begun.created) return responseFor(begun.record);

    try {
      const published = await this.deps.github.publishPullRequestReview({
        owner: context.data.target.repositoryOwner,
        name: context.data.target.repositoryName,
        pullRequestNumber: context.data.target.pullRequestNumber,
        headSha: context.data.target.headSha,
        event: request.event,
        body: `${request.summary}\n\n${marker}`,
        comments: request.comments,
      });
      await this.deps.publications.complete(
        publicationKey,
        published.providerReviewId,
        this.deps.now()
      );
      return {
        publicationKey,
        state: "completed",
        providerReviewId: published.providerReviewId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GitHubReviewPublicationError && error.outcome === "definite") {
        await this.deps.publications.fail(publicationKey, message, this.deps.now());
      } else {
        await this.deps.publications.markUncertain(publicationKey, message, this.deps.now());
      }
      throw error;
    }
  }
}
