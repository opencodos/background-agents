import { z } from "zod";
import { fetchWithTimeout, getCachedInstallationToken } from "../auth/github-app";
import { SourceControlProviderError, parseProviderResponse } from "./errors";
import { GITHUB_API_BASE, USER_AGENT } from "./providers/constants";
import type { GitHubProviderConfig } from "./providers/types";

const githubFeedbackAuthorSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const githubPullRequestCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.url(),
  issue_url: z.url(),
  user: githubFeedbackAuthorSchema,
});

const githubPullRequestReviewSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  html_url: z.url(),
  state: z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  user: githubFeedbackAuthorSchema,
});

const githubReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.url(),
  path: z.string(),
  line: z.number().nullable().optional(),
  start_line: z.number().nullable().optional(),
  side: z.string().nullable().optional(),
  start_side: z.string().nullable().optional(),
  diff_hunk: z.string(),
});

const githubCollaboratorPermissionSchema = z.object({
  permission: z.enum(["none", "read", "triage", "write", "maintain", "admin"]),
});

const githubPublishedReviewSchema = z.object({
  id: z.number(),
  html_url: z.url(),
});

export interface PublishGitHubReviewConfig {
  owner: string;
  name: string;
  pullRequestNumber: number;
  headSha: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{
    path: string;
    line: number;
    startLine?: number;
    side: "LEFT" | "RIGHT";
    startSide?: "LEFT" | "RIGHT";
    body: string;
  }>;
}

export class GitHubReviewPublicationError extends Error {
  constructor(
    message: string,
    readonly outcome: "definite" | "uncertain"
  ) {
    super(message);
    this.name = "GitHubReviewPublicationError";
  }
}

interface GitHubPullRequestFeedbackLocation {
  owner: string;
  name: string;
  pullRequestNumber: number;
}

export type GetGitHubPullRequestFeedbackConfig = GitHubPullRequestFeedbackLocation &
  (
    | { providerObject: { kind: "pr_comment"; id: string } }
    | { providerObject: { kind: "review"; id: string } }
  );

export interface GitHubFeedbackAuthor {
  id: string;
  login: string;
  type: string;
}

export type GitHubPullRequestFeedback =
  | {
      kind: "pr_comment";
      id: string;
      body: string;
      url: string;
      author: GitHubFeedbackAuthor;
    }
  | {
      kind: "review";
      id: string;
      body: string;
      url: string;
      state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
      author: GitHubFeedbackAuthor;
      comments: GitHubReviewComment[];
    };

export interface GitHubReviewComment {
  id: string;
  body: string;
  url: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: string | null;
  startSide: string | null;
  diffHunk: string;
}

export const MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS = 100;
const GITHUB_REVIEW_COMMENTS_PER_PAGE = 100;

function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

export class GitHubPullRequestFeedbackClient {
  private readonly appConfig?: GitHubProviderConfig["appConfig"];
  private readonly cacheStore?: GitHubProviderConfig["cacheStore"];
  private readonly userAgent: string;

  constructor(config: GitHubProviderConfig = {}) {
    this.appConfig = config.appConfig;
    this.cacheStore = config.cacheStore;
    this.userAgent = config.userAgent || USER_AGENT;
  }

  async publishPullRequestReview(config: PublishGitHubReviewConfig): Promise<{
    providerReviewId: string;
    url: string;
  }> {
    let token: string;
    try {
      token = await this.getAppToken("publish pull request review");
    } catch (error) {
      throw new GitHubReviewPublicationError(
        `GitHub review publication did not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "definite"
      );
    }
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/pulls/${config.pullRequestNumber}/reviews`,
        {
          method: "POST",
          headers: {
            ...this.appHeaders(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            commit_id: config.headSha,
            event: config.event,
            body: config.body,
            comments: config.comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              ...(comment.startLine === undefined ? {} : { start_line: comment.startLine }),
              side: comment.side,
              ...(comment.startSide === undefined ? {} : { start_side: comment.startSide }),
              body: comment.body,
            })),
          }),
        }
      );
    } catch (error) {
      throw new GitHubReviewPublicationError(
        `GitHub review publication outcome is unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "uncertain"
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GitHubReviewPublicationError(
        `GitHub rejected review publication: ${response.status} ${detail}`,
        response.status >= 500 ? "uncertain" : "definite"
      );
    }
    try {
      const review = await parseProviderResponse(
        response,
        githubPublishedReviewSchema,
        "GitHub returned an invalid published review"
      );
      return {
        providerReviewId: String(review.id),
        url: review.html_url,
      };
    } catch (error) {
      throw new GitHubReviewPublicationError(
        `GitHub accepted a review but its identity is unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "uncertain"
      );
    }
  }

  async findPullRequestReviewsByMarker(config: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    marker: string;
  }): Promise<Array<{ providerReviewId: string; authorLogin: string; url: string }>> {
    const token = await this.getAppToken("search pull request reviews");
    const candidates: Array<{
      providerReviewId: string;
      authorLogin: string;
      url: string;
    }> = [];
    for (let page = 1; ; page += 1) {
      const response = await fetchWithTimeout(
        `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/pulls/${config.pullRequestNumber}/reviews?per_page=100&page=${page}`,
        { headers: this.appHeaders(token) }
      );
      if (!response.ok) {
        const detail = await response.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to search pull request reviews: ${response.status} ${detail}`,
          new Error(detail),
          response.status
        );
      }
      const reviews = await parseProviderResponse(
        response,
        z.array(githubPullRequestReviewSchema),
        "Failed to search pull request reviews"
      );
      candidates.push(
        ...reviews
          .filter((review) => (review.body ?? "").includes(config.marker))
          .map((review) => ({
            providerReviewId: String(review.id),
            authorLogin: review.user.login,
            url: review.html_url,
          }))
      );
      if (reviews.length < 100) return candidates;
    }
  }

  async getPullRequestFeedback(
    config: GetGitHubPullRequestFeedbackConfig
  ): Promise<GitHubPullRequestFeedback> {
    const token = await this.getAppToken("get pull request feedback");
    if (config.providerObject.kind === "review") {
      return this.getPullRequestReviewFeedback(token, config, config.providerObject.id);
    }

    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/issues/comments/${encodeURIComponent(config.providerObject.id)}`,
      { headers: this.appHeaders(token) }
    );
    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request comment: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const data = await parseProviderResponse(
      response,
      githubPullRequestCommentSchema,
      "Failed to get pull request comment"
    );
    const expectedIssuePath =
      `/repos/${config.owner}/${config.name}/issues/${config.pullRequestNumber}`.toLowerCase();
    if (
      String(data.id) !== config.providerObject.id ||
      new URL(data.issue_url).pathname.toLowerCase() !== expectedIssuePath
    ) {
      throw new SourceControlProviderError(
        "Pull request comment does not belong to the requested pull request",
        "permanent"
      );
    }

    return {
      kind: "pr_comment",
      id: String(data.id),
      body: data.body,
      url: data.html_url,
      author: {
        id: String(data.user.id),
        login: data.user.login,
        type: data.user.type,
      },
    };
  }

  async hasPullRequestWritePermission(config: {
    owner: string;
    name: string;
    authorLogin: string;
  }): Promise<boolean> {
    const token = await this.getAppToken("check pull request author permission");
    const response = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/collaborators/${encodeURIComponent(config.authorLogin)}/permission`,
      { headers: this.appHeaders(token) }
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      const error = await response.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get collaborator permission: ${response.status} ${error}`,
        new Error(error),
        response.status
      );
    }

    const { permission } = await parseProviderResponse(
      response,
      githubCollaboratorPermissionSchema,
      "Failed to get collaborator permission"
    );
    return permission === "write" || permission === "maintain" || permission === "admin";
  }

  private async getPullRequestReviewFeedback(
    token: string,
    config: GitHubPullRequestFeedbackLocation,
    reviewId: string
  ): Promise<Extract<GitHubPullRequestFeedback, { kind: "review" }>> {
    const reviewUrl = `${GITHUB_API_BASE}/repos/${config.owner}/${config.name}/pulls/${config.pullRequestNumber}/reviews/${encodeURIComponent(reviewId)}`;
    const reviewResponse = await fetchWithTimeout(reviewUrl, {
      headers: this.appHeaders(token),
    });
    if (!reviewResponse.ok) {
      const error = await reviewResponse.text();
      throw SourceControlProviderError.fromFetchError(
        `Failed to get pull request review: ${reviewResponse.status} ${error}`,
        new Error(error),
        reviewResponse.status
      );
    }
    const review = await parseProviderResponse(
      reviewResponse,
      githubPullRequestReviewSchema,
      "Failed to get pull request review"
    );
    if (String(review.id) !== reviewId) {
      throw new SourceControlProviderError(
        "Pull request review identity did not match the requested review",
        "permanent"
      );
    }

    const comments: GitHubReviewComment[] = [];
    for (let page = 1; ; page += 1) {
      const commentsResponse = await fetchWithTimeout(
        `${reviewUrl}/comments?per_page=${GITHUB_REVIEW_COMMENTS_PER_PAGE}&page=${page}`,
        { headers: this.appHeaders(token) }
      );
      if (!commentsResponse.ok) {
        const error = await commentsResponse.text();
        throw SourceControlProviderError.fromFetchError(
          `Failed to get pull request review comments: ${commentsResponse.status} ${error}`,
          new Error(error),
          commentsResponse.status
        );
      }
      const pageComments = await parseProviderResponse(
        commentsResponse,
        z.array(githubReviewCommentSchema),
        "Failed to get pull request review comments"
      );
      if (comments.length + pageComments.length > MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS) {
        throw new SourceControlProviderError(
          `Pull request review exceeds the Autofix limit of ${MAX_GITHUB_AUTOFIX_REVIEW_COMMENTS} comments`,
          "permanent"
        );
      }
      comments.push(
        ...pageComments.map((comment) => ({
          id: String(comment.id),
          body: comment.body,
          url: comment.html_url,
          path: comment.path,
          line: comment.line ?? null,
          startLine: comment.start_line ?? null,
          side: comment.side ?? null,
          startSide: comment.start_side ?? null,
          diffHunk: comment.diff_hunk,
        }))
      );
      if (pageComments.length < GITHUB_REVIEW_COMMENTS_PER_PAGE) break;
    }

    return {
      kind: "review",
      id: String(review.id),
      body: review.body ?? "",
      url: review.html_url,
      state: review.state,
      author: {
        id: String(review.user.id),
        login: review.user.login,
        type: review.user.type,
      },
      comments,
    };
  }

  private async getAppToken(operation: string): Promise<string> {
    if (!this.appConfig) {
      throw new SourceControlProviderError(
        `GitHub App not configured - cannot ${operation}`,
        "permanent"
      );
    }
    try {
      return await getCachedInstallationToken(this.appConfig, {
        cacheStore: this.cacheStore,
        userAgent: this.userAgent,
      });
    } catch (error) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to generate GitHub App token: ${error instanceof Error ? error.message : String(error)}`,
        error,
        extractHttpStatus(error)
      );
    }
  }

  private appHeaders(token: string): Record<string, string> {
    return {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": this.userAgent,
    };
  }
}
