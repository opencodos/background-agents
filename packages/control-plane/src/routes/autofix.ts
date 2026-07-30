import { createKvCacheStore, resolveAppName } from "@open-inspect/shared";
import { z } from "zod";
import { getGitHubAppConfig } from "../auth/github-app";
import { GitHubReviewPublicationStore } from "../db/github-review-publication-store";
import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import { GitHubPullRequestFeedbackClient } from "../source-control/github-pull-request-feedback-client";
import type { Env } from "../types";
import type { Route } from "./shared";
import { error, json, parsePattern, type RequestContext } from "./shared";

const reconciliationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search") }),
  z.object({ action: z.literal("abandon") }),
  z.object({
    action: z.literal("confirm"),
    providerReviewId: z.string().min(1),
  }),
]);

function githubProvider(env: Env): GitHubPullRequestFeedbackClient {
  return new GitHubPullRequestFeedbackClient({
    appConfig: getGitHubAppConfig(env) ?? undefined,
    cacheStore: createKvCacheStore(env.REPOS_CACHE),
    userAgent: resolveAppName(env),
  });
}

export function isReviewReconciliationCandidate(
  publication: { marker: string },
  review: {
    kind: "pr_comment" | "review";
    body: string;
    author: { login: string };
  },
  botUsername: string
): boolean {
  return (
    review.kind === "review" &&
    review.author.login.toLowerCase() === botUsername.toLowerCase() &&
    review.body.includes(publication.marker)
  );
}

async function handleActivity(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service" || ctx.principal.service !== "web") {
    return error("Unauthorized", 401);
  }

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit") ?? "50";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return error("limit must be an integer from 1 to 100", 400);
  }

  try {
    return json(
      await new PrAutofixFeedbackStore(ctx.db).listActivity({
        limit,
        cursor: url.searchParams.get("cursor"),
      })
    );
  } catch (caught) {
    if (caught instanceof Error && caught.message === "Invalid Autofix activity cursor") {
      return error(caught.message, 400);
    }
    throw caught;
  }
}

async function handlePublicationReconciliation(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service" || ctx.principal.service !== "web") {
    return error("Unauthorized", 401);
  }

  const publicationKey = match.groups?.key;
  if (!publicationKey) return error("Publication key required", 400);
  const parsed = reconciliationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error("Invalid reconciliation request", 400);

  const publications = new GitHubReviewPublicationStore(ctx.db);
  const publication = await publications.get(publicationKey);
  if (!publication) return error("Review publication not found", 404);
  const github = githubProvider(env);
  const findCandidates = () =>
    github.findPullRequestReviewsByMarker({
      owner: publication.repoOwner,
      name: publication.repoName,
      pullRequestNumber: publication.prNumber,
      marker: publication.marker,
    });
  if (parsed.data.action === "search") {
    return json({ candidates: await findCandidates() });
  }
  if (parsed.data.action === "abandon") {
    if ((await findCandidates()).length > 0) {
      return error("A matching review exists and must be confirmed", 409);
    }
    await publications.abandon(publication.publicationKey, Date.now());
    return json({ publicationKey: publication.publicationKey, state: "failed" });
  }

  const review = await github.getPullRequestFeedback({
    owner: publication.repoOwner,
    name: publication.repoName,
    pullRequestNumber: publication.prNumber,
    providerObject: {
      kind: "review",
      id: parsed.data.providerReviewId,
    },
  });
  const isOwnedCandidate = isReviewReconciliationCandidate(
    publication,
    review,
    env.GITHUB_BOT_USERNAME
  );
  if (!isOwnedCandidate) {
    return error("Review does not match the publication receipt", 409);
  }
  await publications.reconcileCompleteAndReopenFeedback(
    publication.publicationKey,
    parsed.data.providerReviewId,
    Date.now()
  );
  return json({
    publicationKey: publication.publicationKey,
    state: "completed",
    providerReviewId: parsed.data.providerReviewId,
  });
}

export const autofixRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/autofix/activity"),
    handler: handleActivity,
  },
  {
    method: "POST",
    pattern: parsePattern("/autofix/review-publications/:key/reconcile"),
    handler: handlePublicationReconciliation,
  },
];
