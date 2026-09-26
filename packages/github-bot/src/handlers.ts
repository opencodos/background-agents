import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type GitHubReviewCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { signedControlPlaneFetch } from "./internal-auth";
import type {
  Env,
  PullRequestReviewTriggerPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postCommitStatus,
  postReaction,
  checkSenderPermission,
  getPullRequestApproval,
  getPullRequestSnapshot,
  getReviewStatusState,
  REVIEW_PENDING_DESCRIPTION,
  REVIEW_SKIPPED_APPROVED_DESCRIPTION,
  REVIEW_START_FAILED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
} from "./github-auth";
import { buildCodeReviewPrompt, buildCommentActionPrompt } from "./prompts";
import { resolveSessionTarget, type SessionTargetFields } from "./session-target";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import { containsBotMention, stripBotMention } from "./github-mention";
import { closeOutReviewStatus } from "./review-close-out";
import {
  claimReviewGeneration,
  releaseReviewGeneration,
  sweepStaleReviews,
} from "./review-supersession";

export type HandlerResult =
  | {
      outcome: "processed";
      handler_action: string;
      session_id?: string;
      message_id?: string;
    }
  | { outcome: "skipped"; skip_reason: string };

/** Session creation was rejected because a newer review claimed the PR's generation first. */
class ReviewSupersededError extends Error {}

/** The control plane answered a prompt with a 4xx: the prompt was definitely not accepted. */
class PromptRejectedError extends Error {}

/**
 * The logins a review request may name to reach this bot: the webhook App itself and, when a
 * second App submits the reviews, that App too — it is the one GitHub lists as the reviewer, so
 * the re-request button on a PR it reviewed names it, never the webhook App.
 */
export function reviewRequestLogins(
  env: Pick<Env, "GITHUB_BOT_USERNAME" | "GITHUB_REVIEWER_USERNAME">
): string[] {
  const reviewerLogin = env.GITHUB_REVIEWER_USERNAME?.trim();
  return reviewerLogin ? [env.GITHUB_BOT_USERNAME, reviewerLogin] : [env.GITHUB_BOT_USERNAME];
}

export function isReviewRequestedForBot(
  payload: unknown,
  acceptedLogins: readonly string[]
): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  const login = parsed.data.requested_reviewer?.login;
  return login !== undefined && acceptedLogins.includes(login);
}

async function createSession(
  env: Env,
  traceId: string,
  params: {
    target: SessionTargetFields;
    title: string;
    model: string;
    reasoningEffort?: string | null;
    scmLogin: string;
    scmUserId: string;
    scmAvatarUrl: string;
    githubReview?: {
      repoId: number;
      prNumber: number;
      generation: number;
      headSha: string;
      owner: string;
      repo: string;
    };
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    ...params.target,
    title: params.title,
    model: params.model,
    scmLogin: params.scmLogin,
    scmAvatarUrl: params.scmAvatarUrl,
  };
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  if (params.githubReview) {
    body.githubReview = params.githubReview;
  }
  const url = "https://internal/sessions";
  const bodyText = JSON.stringify(body);
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: `github:${params.scmUserId}`,
    traceId,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (params.githubReview && response.status === 409) {
      throw new ReviewSupersededError(`Session creation superseded: ${errorBody}`);
    }
    throw new Error(`Session creation failed: ${response.status} ${errorBody}`);
  }
  const result = createSessionResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Session creation failed: invalid response");
  }
  return result.data.sessionId;
}

async function sendPrompt(
  env: Env,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string; callbackContext?: GitHubReviewCallbackContext }
): Promise<string> {
  const url = `https://internal/sessions/${sessionId}/prompt`;
  const bodyText = JSON.stringify({
    content: params.content,
    source: "github",
    ...(params.callbackContext ? { callbackContext: params.callbackContext } : {}),
  });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: params.authorId.startsWith("github:") ? params.authorId : undefined,
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    const message = `Prompt delivery failed: ${response.status} ${body}`;
    throw response.status >= 400 && response.status < 500
      ? new PromptRejectedError(message)
      : new Error(message);
  }
  const result = sendPromptResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  return result.data.messageId;
}

async function withReaction<T>(
  log: Logger,
  token: string,
  url: string,
  userAgent: string,
  meta: Record<string, unknown>,
  action: () => Promise<T>
): Promise<T> {
  const reaction = postReaction(token, url, "eyes", userAgent).then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
  try {
    return await action();
  } finally {
    await reaction;
  }
}

interface ReviewStatusTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Mark a just-admitted review as in progress. The one commit-status write made without the PR's
 * submission lease: it is the start marker for the generation this handler has just admitted.
 */
async function postPendingReviewStatus(
  log: Logger,
  token: string,
  target: ReviewStatusTarget,
  userAgent: string,
  meta: Record<string, unknown>
): Promise<void> {
  const result = await postCommitStatus(
    token,
    target.owner,
    target.repo,
    target.headSha,
    {
      state: "pending",
      context: REVIEW_STATUS_CONTEXT,
      description: REVIEW_PENDING_DESCRIPTION,
    },
    userAgent
  );
  const statusMeta = { ...meta, head_sha: target.headSha, state: "pending" };
  if (result.ok) {
    log.debug("review_status.posted", statusMeta);
    return;
  }
  log.warn("review_status.failed", {
    ...statusMeta,
    ...(result.status === undefined ? {} : { github_status: result.status }),
    error: result.error,
  });
}

/**
 * Deliver a review prompt with a callback context naming the commit its "pending" status sits on,
 * so the session's end comes back to `/callbacks/complete` however the agent stops — including the
 * endings (timeout, cancel, a lost sandbox) that never reach the prompt's own submission step.
 *
 * A session whose prompt never arrives has no turn to end, so no callback will ever close it out.
 * When the control plane definitively rejected the prompt (a 4xx), its close-out is requested
 * here, through the same lease as every other. Any other failure — a transport error, a 5xx, an
 * unreadable answer — is ambiguous: the prompt may have been accepted, and recording a close-out
 * would fence out a live review. Those are left to the control plane's reaper, which asks the
 * session itself after a grace period and closes it out only if it holds no prompt.
 */
async function sendReviewPrompt(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string },
  target: ReviewStatusTarget
): Promise<string> {
  const callbackContext: GitHubReviewCallbackContext = { source: "github", ...target };
  try {
    return await sendPrompt(env, traceId, sessionId, {
      content: params.content,
      authorId: params.authorId,
      callbackContext,
    });
  } catch (error) {
    if (error instanceof PromptRejectedError) {
      await closeOutReviewStatus(env, log, traceId, {
        sessionId,
        request: {
          owner: target.owner,
          repo: target.repo,
          description: REVIEW_START_FAILED_DESCRIPTION,
        },
      });
    }
    throw error;
  }
}

/**
 * Stand down an auto-review on a PR that already carries an approval, leaving nothing behind that
 * outlives the decision. The outcome tells the caller what to do next:
 *
 * - `stood_down`: the head's status is established — the skip written, or a terminal status
 *   already there — and older reviews are fenced and swept. Skip the review.
 * - `stale`: the live PR no longer matches the event (another head, closed, or back to draft).
 *   Nothing was claimed, swept, or written: a delayed event must not act on a newer head's review.
 * - `review`: the skip could not be established safely, so review the PR as normal instead. A
 *   stand-down without its status would leave the head with no `open-inspect` status at all (a
 *   required check that never appears), or a swept same-head review's close-out publishing an
 *   error — and nothing would ever retry it. The claim is released first when it was taken, so
 *   the previous review can still publish if the fallback review cannot start.
 *
 * The new head's "skipped" success is a terminal status written without the PR's submission lease
 * — there is no session to hold it — so the ownership rule is kept by ordering and a read instead:
 *
 * 1. Claim a generation first. Every older review is now superseded: none can take the lease from
 *    here on (its acquire answers 409), so none can start a status write after this point. With
 *    no claim nothing is fenced, so no skip is written.
 * 2. Write the skip only where the head's status is pending or absent. A review of this head that
 *    already published, or was already closed out, keeps its own terminal status.
 * 3. Sweep last, naming the repository. A review whose head this push replaced is closed out under
 *    the lease ("Superseded by a newer commit"); a same-head review cancelled here finds the skip
 *    already terminal, so its close-out writes nothing.
 *
 * Residual race: a writer that already held the lease when the claim landed — an agent
 * mid-submission, or a granted close-out that has read "pending" — can land its write after the
 * skip, because GitHub statuses have no compare-and-swap. The head then shows that review's own
 * verdict, or its close-out's error, instead of the skip. Only a same-head review can do this, and
 * only within one lease TTL of the claim.
 */
async function standDownApprovedReview(
  env: Env,
  log: Logger,
  traceId: string,
  params: { repoId: number; prNumber: number },
  target: { owner: string; repo: string; headSha: string },
  token: string,
  userAgent: string,
  meta: Record<string, unknown>
): Promise<"stood_down" | "stale" | "review"> {
  // The same freshness check the review path makes before its claim. An unreadable PR is left to
  // that path, which makes the check again and skips on its own terms.
  const freshness = await getPullRequestSnapshot(
    token,
    target.owner,
    target.repo,
    params.prNumber,
    userAgent
  );
  if (!freshness.ok) return "review";
  if (freshness.headSha !== target.headSha || freshness.state !== "open" || freshness.draft) {
    log.debug("handler.stale_head_sha", {
      ...meta,
      current_head_sha: freshness.headSha,
      expected_head_sha: target.headSha,
      state: freshness.state,
      draft: freshness.draft,
    });
    return "stale";
  }

  let generation: number;
  try {
    generation = await claimReviewGeneration(env, traceId, params);
  } catch (error) {
    log.warn("handler.approved_skip_claim_failed", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return "review";
  }
  const status = await getReviewStatusState(
    token,
    target.owner,
    target.repo,
    target.headSha,
    userAgent
  );
  if (!status.ok) {
    // Not evidence the status is still pending: writing could replace a verdict.
    log.warn("handler.approved_skip_status_unreadable", { ...meta, error: status.error });
    await releaseReviewGeneration(env, log, traceId, { ...params, generation });
    return "review";
  } else if (status.state === null || status.state === "pending") {
    const result = await postCommitStatus(
      token,
      target.owner,
      target.repo,
      target.headSha,
      {
        state: "success",
        context: REVIEW_STATUS_CONTEXT,
        description: REVIEW_SKIPPED_APPROVED_DESCRIPTION,
      },
      userAgent
    );
    if (!result.ok) {
      log.warn("handler.approved_skip_status_failed", { ...meta, error: result.error });
      await releaseReviewGeneration(env, log, traceId, { ...params, generation });
      return "review";
    }
  } else {
    log.info("handler.approved_skip_status_kept", { ...meta, state: status.state });
  }

  await sweepStaleReviews(env, log, traceId, {
    ...params,
    generation,
    owner: target.owner,
    repo: target.repo,
  });
  return "stood_down";
}

type CallerGatingResult =
  | { allowed: true; ghToken: string }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  // An event whose sender is our own app identity — a PR this app opened, a push it made to its
  // own branch — is the app acting, not a third party asking it to act. Neither caller gate can
  // express that: a human allowlist never names the bot, and the collaborator-permission lookup
  // 404s for a `[bot]` login, so both fail closed on every self-originated event.
  const isOwnAppIdentity = senderLogin.toLowerCase() === env.GITHUB_BOT_USERNAME.toLowerCase();

  if (!isOwnAppIdentity && config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed" };
    }
  }

  const userAgent = resolveAppName(env);
  const ghToken = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  if (!isOwnAppIdentity && config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin,
      userAgent
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason };
    }
  }

  return { allowed: true, ghToken };
}

/**
 * The account whose token submits reviews, and whether that is a second App.
 * `hasReviewerApp` gates the prompt's token fetch; `submittingLogin` decides
 * whether GitHub would refuse an approval as a self-review.
 */
function resolveReviewIdentity(env: Env): { submittingLogin: string; hasReviewerApp: boolean } {
  const reviewerLogin = env.GITHUB_REVIEWER_USERNAME?.trim();
  return {
    submittingLogin: reviewerLogin || env.GITHUB_BOT_USERNAME,
    hasReviewerApp: Boolean(reviewerLogin),
  };
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!requested_reviewer || !reviewRequestLogins(env).includes(requested_reviewer.login)) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  const userAgent = resolveAppName(env);
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    userAgent,
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });

      // Freshness runs as the last await before claim: any earlier network-bound
      // step (target resolution) widens the window in which a close/draft
      // tombstone or newer push could outrank this snapshot.
      const freshness = await getPullRequestSnapshot(
        ghToken,
        owner,
        repoName,
        pr.number,
        userAgent
      );
      if (!freshness.ok) {
        log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
        return { outcome: "skipped", skip_reason: "freshness_check_failed" };
      }
      if (freshness.headSha !== pr.head.sha || freshness.state !== "open") {
        log.debug("handler.stale_head_sha", {
          ...meta,
          current_head_sha: freshness.headSha,
          expected_head_sha: pr.head.sha,
          state: freshness.state,
          draft: freshness.draft,
        });
        return { outcome: "skipped", skip_reason: "stale_head_sha" };
      }

      const generation = await claimReviewGeneration(env, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
      });

      let sessionId: string;
      try {
        sessionId = await createSession(env, traceId, {
          target,
          title: `GitHub: Review PR #${pr.number}`,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          scmLogin: sender.login,
          scmUserId: String(sender.id),
          scmAvatarUrl: sender.avatar_url,
          githubReview: {
            repoId: repo.id,
            prNumber: pr.number,
            generation,
            headSha: pr.head.sha,
            owner,
            repo: repoName,
          },
        });
      } catch (error) {
        if (error instanceof ReviewSupersededError) {
          // A newer trigger already owns the fence; its claim must stand.
          log.info("handler.review_superseded", { ...meta, generation });
          return { outcome: "skipped", skip_reason: "superseded" };
        }
        // The claim bumped the fence but no session will ever carry it. Roll it
        // back so a review still running on the previous generation is not
        // permanently locked out of submitting.
        await releaseReviewGeneration(env, log, traceId, {
          repoId: repo.id,
          prNumber: pr.number,
          generation,
        });
        throw error;
      }

      await sweepStaleReviews(env, log, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
        generation,
        owner,
        repo: repoName,
      });

      const statusTarget = { owner, repo: repoName, prNumber: pr.number, headSha: pr.head.sha };
      await postPendingReviewStatus(log, ghToken, statusTarget, userAgent, meta);
      log.info("session.created", { ...meta, session_id: sessionId, action: "review" });

      const reviewIdentity = resolveReviewIdentity(env);
      const prompt = buildCodeReviewPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        headSha: pr.head.sha,
        isDraft: freshness.draft,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
        isSelfReview: pr.user.login.toLowerCase() === reviewIdentity.submittingLogin.toLowerCase(),
        hasReviewerApp: reviewIdentity.hasReviewerApp,
      });

      const messageId = await sendReviewPrompt(
        env,
        log,
        traceId,
        sessionId,
        { content: prompt, authorId: `github:${payload.sender.id}` },
        statusTarget
      );
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "review",
      };
    }
  );
}

export async function handlePullRequestReviewTrigger(
  env: Env,
  log: Logger,
  payload: PullRequestReviewTriggerPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  if (!config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  const userAgent = resolveAppName(env);

  // A standing approval ends automatic reviewing of this PR: once someone has signed off, spending
  // a full session on every follow-up push re-reviews work the approval already covers. Only the
  // automatic triggers stop here — an @mention or a `review_requested` is a person asking for the
  // review regardless, and neither routes through this handler.
  //
  // `opened` is exempt from the lookup rather than the rule: a PR GitHub has just created cannot
  // carry a review yet, so the call could only ever come back empty.
  if (payload.action !== "opened") {
    const approval = await getPullRequestApproval(ghToken, owner, repoName, pr.number, userAgent);
    if (!approval.ok) {
      // Fail open. An unreadable approval state is not evidence of an approval, and losing a
      // review outright is a worse failure than one redundant run.
      log.warn("handler.approval_check_failed", { ...meta, error: approval.error });
    } else if (approval.approved) {
      const standDown = await standDownApprovedReview(
        env,
        log,
        traceId,
        { repoId: repo.id, prNumber: pr.number },
        { owner, repo: repoName, headSha: pr.head.sha },
        ghToken,
        userAgent,
        meta
      );
      if (standDown === "stale") return { outcome: "skipped", skip_reason: "stale_head_sha" };
      if (standDown === "stood_down") {
        log.info("handler.pr_already_approved", meta);
        return { outcome: "skipped", skip_reason: "pr_approved" };
      }
      // The skip could not be established; a review always leaves a status behind. Its own
      // claim supersedes any the stand-down left, and its sweep retires every older review.
      log.info("handler.pr_approved_reviewing_anyway", meta);
    }
  }

  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/${pr.number}/reactions`,
    userAgent,
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });

      // Freshness runs as the last await before claim: any earlier network-bound
      // step (target resolution) widens the window in which a close/draft
      // tombstone or newer push could outrank this snapshot.
      const freshness = await getPullRequestSnapshot(
        ghToken,
        owner,
        repoName,
        pr.number,
        userAgent
      );
      if (!freshness.ok) {
        log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
        return { outcome: "skipped", skip_reason: "freshness_check_failed" };
      }
      if (freshness.headSha !== pr.head.sha || freshness.state !== "open" || freshness.draft) {
        log.debug("handler.stale_head_sha", {
          ...meta,
          current_head_sha: freshness.headSha,
          expected_head_sha: pr.head.sha,
          state: freshness.state,
          draft: freshness.draft,
        });
        return { outcome: "skipped", skip_reason: "stale_head_sha" };
      }

      const generation = await claimReviewGeneration(env, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
      });

      let sessionId: string;
      try {
        sessionId = await createSession(env, traceId, {
          target,
          title: `GitHub: Review PR #${pr.number}`,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          scmLogin: sender.login,
          scmUserId: String(sender.id),
          scmAvatarUrl: sender.avatar_url,
          githubReview: {
            repoId: repo.id,
            prNumber: pr.number,
            generation,
            headSha: pr.head.sha,
            owner,
            repo: repoName,
          },
        });
      } catch (error) {
        if (error instanceof ReviewSupersededError) {
          // A newer trigger already owns the fence; its claim must stand.
          log.info("handler.review_superseded", { ...meta, generation });
          return { outcome: "skipped", skip_reason: "superseded" };
        }
        // The claim bumped the fence but no session will ever carry it. Roll it
        // back so a review still running on the previous generation is not
        // permanently locked out of submitting.
        await releaseReviewGeneration(env, log, traceId, {
          repoId: repo.id,
          prNumber: pr.number,
          generation,
        });
        throw error;
      }

      await sweepStaleReviews(env, log, traceId, {
        repoId: repo.id,
        prNumber: pr.number,
        generation,
        owner,
        repo: repoName,
      });

      const statusTarget = { owner, repo: repoName, prNumber: pr.number, headSha: pr.head.sha };
      await postPendingReviewStatus(log, ghToken, statusTarget, userAgent, meta);
      log.info("session.created", { ...meta, session_id: sessionId, action: "auto_review" });

      const reviewIdentity = resolveReviewIdentity(env);
      const prompt = buildCodeReviewPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user.login,
        base: pr.base.ref,
        head: pr.head.ref,
        headSha: pr.head.sha,
        isDraft: freshness.draft,
        isPublic: !repo.private,
        codeReviewInstructions: config.codeReviewInstructions,
        isSelfReview: pr.user.login.toLowerCase() === reviewIdentity.submittingLogin.toLowerCase(),
        hasReviewerApp: reviewIdentity.hasReviewerApp,
      });

      const messageId = await sendReviewPrompt(
        env,
        log,
        traceId,
        sessionId,
        { content: prompt, authorId: `github:${sender.id}` },
        statusTarget
      );
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "auto_review",
      };
    }
  );
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const commentBody = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: issue.number };
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/issues/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, traceId, {
        target,
        title: `GitHub: PR #${issue.number} comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      log.info("session.created", { ...meta, session_id: sessionId, action: "comment" });

      const prompt = buildCommentActionPrompt({
        owner,
        repo: repoName,
        number: issue.number,
        title: issue.title,
        commentBody,
        commenter: sender.login,
        isPublic: !repo.private,
        commentActionInstructions: config.commentActionInstructions,
      });

      const messageId = await sendPrompt(env, traceId, sessionId, {
        content: prompt,
        authorId: `github:${sender.id}`,
      });
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "comment",
      };
    }
  );
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const repoFullName = `${owner}/${repoName}`.toLowerCase();

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (sender.login === env.GITHUB_BOT_USERNAME) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;

  const commentBody = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);

  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pr.number };
  return withReaction(
    log,
    ghToken,
    `https://api.github.com/repos/${repositoryPath}/pulls/comments/${comment.id}/reactions`,
    resolveAppName(env),
    meta,
    async () => {
      const target = await resolveSessionTarget(env, log, {
        owner,
        repoName,
        senderLogin: sender.login,
        config,
        ghToken,
        traceId,
      });
      const sessionId = await createSession(env, traceId, {
        target,
        title: `GitHub: PR #${pr.number} review comment`,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        scmLogin: sender.login,
        scmUserId: String(sender.id),
        scmAvatarUrl: sender.avatar_url,
      });
      log.info("session.created", { ...meta, session_id: sessionId, action: "review_comment" });

      const prompt = buildCommentActionPrompt({
        owner,
        repo: repoName,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
        head: pr.head.ref,
        commentBody,
        commenter: sender.login,
        isPublic: !repo.private,
        filePath: comment.path,
        diffHunk: comment.diff_hunk,
        commentId: comment.id,
        commentActionInstructions: config.commentActionInstructions,
      });

      const messageId = await sendPrompt(env, traceId, sessionId, {
        content: prompt,
        authorId: `github:${sender.id}`,
      });
      log.info("prompt.sent", {
        ...meta,
        session_id: sessionId,
        message_id: messageId,
        source: "github",
        content_length: prompt.length,
      });

      return {
        outcome: "processed",
        session_id: sessionId,
        message_id: messageId,
        handler_action: "review_comment",
      };
    }
  );
}
