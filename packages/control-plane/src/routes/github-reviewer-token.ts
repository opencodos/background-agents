/**
 * Sandbox-authenticated broker for the optional reviewer GitHub App.
 * The review POST alone uses this App, so PRs opened by the main App can be
 * approved. Other GitHub calls retain their existing credential.
 *
 * Mint on demand (with the installation-token cache), not at sandbox launch:
 * a review can outlive a token. Admission binds the sandbox to params.id and
 * no-store prevents downstream caching of the write credential.
 *
 * Admission alone would hand the token to any session's sandbox, so the handler
 * also requires the session to have been spawned by the GitHub bot: the only
 * spawner whose prompt submits reviews. `spawn_source` comes from the
 * authenticated creating principal, not from anything the sandbox controls.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import { Hono } from "hono";
import { getCachedInstallationToken, getGitHubReviewerAppConfig } from "../auth/github-app";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:github-reviewer-token");

export const githubReviewerTokenRoutes = new Hono<ControlPlaneHonoEnv>();

async function handleReviewerToken(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const reviewerAppConfig = getGitHubReviewerAppConfig(env);
  if (!reviewerAppConfig) {
    return error("No reviewer app configured", 404);
  }

  const session = await new SessionIndexStore(ctx.db).get(params.id);
  if (session?.spawnSource !== "github-bot") {
    logger.warn("review_token.session_not_eligible", {
      event: "review_token.session_not_eligible",
      session_id: params.id,
      spawn_source: session?.spawnSource ?? null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Reviewer token is only issued to GitHub bot sessions", 403);
  }

  // Fork-only, depends on #1370's github_review_sessions: GitHub bot sessions also answer
  // comments and never submit a review there, so only a registered review session (one with a
  // review fence row) gets the reviewer credential. Goes upstream once #1370 and #1862 merge.
  const reviewFence = await ctx.db
    .prepare("SELECT 1 FROM github_review_sessions WHERE session_id = ? LIMIT 1")
    .bind(params.id)
    .first();
  if (!reviewFence) {
    logger.warn("review_token.session_not_eligible", {
      event: "review_token.session_not_eligible",
      session_id: params.id,
      spawn_source: session.spawnSource,
      review_fence: false,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Reviewer token is only issued to GitHub review sessions", 403);
  }

  try {
    const token = await getCachedInstallationToken(reviewerAppConfig, {
      cacheStore: env.REPOS_CACHE,
      userAgent: resolveAppName(env),
    });
    return json({ token });
  } catch (cause) {
    logger.error("review_token.mint_failed", {
      event: "review_token.mint_failed",
      session_id: params.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Failed to mint reviewer token", 502);
  }
}

githubReviewerTokenRoutes.get(
  "/sessions/:id/review-token",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleReviewerToken)
);
