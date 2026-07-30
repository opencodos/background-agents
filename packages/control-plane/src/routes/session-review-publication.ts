import {
  createKvCacheStore,
  githubReviewPublicationRequestSchema,
  resolveAppName,
} from "@open-inspect/shared";
import { getGitHubAppConfig } from "../auth/github-app";
import { GitHubReviewPublisher } from "../autofix/review-publisher";
import { GitHubReviewPublicationStore } from "../db/github-review-publication-store";
import { GitHubPullRequestFeedbackClient } from "../source-control/github-pull-request-feedback-client";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

async function handleReviewPublication(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  if (ctx.principal?.kind !== "sandbox" || ctx.principal.sessionId !== sessionId) {
    return error("Only this session's sandbox may publish its review", 403);
  }

  const body = await request.json().catch(() => null);
  const parsed = githubReviewPublicationRequestSchema.safeParse(body);
  if (!parsed.success) return error("Invalid GitHub review publication", 400);

  const appConfig = getGitHubAppConfig(env);
  const publisher = new GitHubReviewPublisher({
    publications: new GitHubReviewPublicationStore(ctx.db),
    sessions: createSessionRuntimeClient(env, ctx),
    github: new GitHubPullRequestFeedbackClient({
      appConfig: appConfig ?? undefined,
      cacheStore: createKvCacheStore(env.REPOS_CACHE),
      userAgent: resolveAppName(env),
    }),
    now: () => Date.now(),
  });
  try {
    return json(await publisher.publish(sessionId, parsed.data));
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : "Review publication failed", 502);
  }
}

export const sessionReviewPublicationRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/github-review"),
    handler: handleReviewPublication,
  },
];
