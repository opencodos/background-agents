/**
 * A PR review's path through startSession: the steps that keep one live review per PR and publish
 * it as the PR head's `open-inspect` status (review supersession), and that let a standing
 * approval end automatic reviewing. startSession runs them in this order:
 *
 * 1. standDownIfApproved — after caller gating, before the acknowledgment reaction.
 * 2. admitReview — the last step before session creation: freshness check, then generation claim.
 * 3. abandonReview — when creation fails: keep a newer trigger's claim, or roll this one back.
 * 4. beginReview — once the session exists: sweep older reviews, write the "pending" start marker.
 * 5. sendReviewPrompt — deliver the prompt with the review's status target as callback context.
 */

import type { GitHubReviewCallbackContext } from "@open-inspect/shared/types/session-api";
import {
  getPullRequestApproval,
  getPullRequestSnapshot,
  getReviewStatusState,
  postCommitStatus,
  REVIEW_PENDING_DESCRIPTION,
  REVIEW_SKIPPED_APPROVED_DESCRIPTION,
  REVIEW_START_FAILED_DESCRIPTION,
  REVIEW_STATUS_CONTEXT,
} from "./github-auth";
import type { Logger } from "./logger";
import { closeOutReviewStatus } from "./review-close-out";
import {
  claimReviewGeneration,
  leaseWriteDeadline,
  releaseReviewGeneration,
  releaseStartMarkerLease,
  requestStartMarkerLease,
  sweepStaleReviews,
  type StartMarkerGrant,
  type StartMarkerLeaseResult,
} from "./review-supersession";
import { PromptRejectedError, sendPrompt, type SessionCreationResult } from "./session-client";
import type { HandlerResult } from "./session-startup";
import type { Env, PullRequestReviewTriggerPayload } from "./types";

/** What a trigger fixes about the review it hands to startSession. */
export interface ReviewRequest {
  /** The head the trigger saw. The review is stale once the PR has moved off it. */
  headSha: string;
  /**
   * The `pull_request` action behind an automatic review. An automatic review skips a PR that has
   * turned draft and stands down on an approved one; a requested review (no action) does neither.
   */
  trigger?: PullRequestReviewTriggerPayload["action"];
}

/** A review's PR and the installation it acts through, once its trigger passed caller gating. */
export interface ReviewContext extends ReviewRequest {
  env: Env;
  log: Logger;
  traceId: string;
  token: string;
  userAgent: string;
  meta: Record<string, unknown>;
  repoId: number;
  owner: string;
  repo: string;
  prNumber: number;
}

/** The create-session field that fences a review's session to the generation its trigger claimed. */
export interface GitHubReviewFence {
  repoId: number;
  prNumber: number;
  generation: number;
  headSha: string;
  /** Where the review's status lives, so a review that never starts can still be closed out. */
  owner: string;
  repo: string;
}

/** A review whose PR generation is claimed: its session is created under that fence. */
export interface AdmittedReview extends ReviewContext {
  /** Whether the PR was a draft at admission; the review's submission requires it unchanged. */
  draft: boolean;
  githubReview: GitHubReviewFence;
}

interface ReviewStatusTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * How long a start marker may take to get the PR's submission lease before its review starts
 * without one: long enough to wait out another holder's live lease, since holders release right
 * after their own writes. A request the control plane has not answered by then is abandoned, so a
 * stalled control plane holds the prompt back no longer than a busy lease does.
 */
export const START_MARKER_LEASE_WAIT_MS = 5_000;

/** Pause between start-marker lease requests while another holder's lease is live. */
const START_MARKER_LEASE_RETRY_MS = 1_000;

/**
 * A standing approval ends automatic reviewing of a PR: once someone has signed off, spending a
 * full session on every follow-up push re-reviews work the approval already covers. Only the
 * automatic triggers stop here — an @mention or a `review_requested` is a person asking for the
 * review regardless.
 *
 * `opened` is exempt from the lookup rather than the rule: a PR GitHub has just created cannot
 * carry a review yet, so the call could only ever come back empty.
 *
 * Returns the skip when the review stood down, or null to review as normal.
 */
export async function standDownIfApproved(review: ReviewContext): Promise<HandlerResult | null> {
  if (review.trigger === undefined || review.trigger === "opened") return null;
  const { env, log, traceId, token, userAgent, meta, repoId, owner, repo, prNumber } = review;

  const approval = await getPullRequestApproval(token, owner, repo, prNumber, userAgent);
  if (!approval.ok) {
    // Fail open. An unreadable approval state is not evidence of an approval, and losing a
    // review outright is a worse failure than one redundant run.
    log.warn("handler.approval_check_failed", { ...meta, error: approval.error });
    return null;
  }
  if (!approval.approved) return null;

  const standDown = await standDownApprovedReview(
    env,
    log,
    traceId,
    { repoId, prNumber },
    { owner, repo, headSha: review.headSha },
    token,
    userAgent,
    meta
  );
  if (standDown === "stale") return { outcome: "skipped", skip_reason: "stale_head_sha" };
  if (standDown === "stood_down") {
    log.info("handler.pr_already_approved", meta);
    return { outcome: "skipped", skip_reason: "pr_approved" };
  }
  // The skip could not be established; a review always leaves a status behind. Its own claim
  // supersedes any the stand-down left, and its sweep retires every older review.
  log.info("handler.pr_approved_reviewing_anyway", meta);
  return null;
}

/**
 * Check the live PR against the trigger, then claim the PR's next review generation. This must be
 * the last step before the review's session is created: any earlier network-bound step (routing,
 * target resolution) widens the window in which a close/draft tombstone or newer push could
 * outrank this snapshot.
 */
export async function admitReview(review: ReviewContext): Promise<HandlerResult | AdmittedReview> {
  const { env, log, traceId, token, userAgent, meta, repoId, owner, repo, prNumber, headSha } =
    review;
  const freshness = await getPullRequestSnapshot(token, owner, repo, prNumber, userAgent);
  if (!freshness.ok) {
    log.warn("handler.freshness_check_failed", { ...meta, error: freshness.error });
    return { outcome: "skipped", skip_reason: "freshness_check_failed" };
  }
  // A requested review runs on a draft; an automatic one stops once the PR has turned draft.
  const draftStale = review.trigger !== undefined && freshness.draft;
  if (freshness.headSha !== headSha || freshness.state !== "open" || draftStale) {
    log.debug("handler.stale_head_sha", {
      ...meta,
      current_head_sha: freshness.headSha,
      expected_head_sha: headSha,
      state: freshness.state,
      draft: freshness.draft,
    });
    return { outcome: "skipped", skip_reason: "stale_head_sha" };
  }

  const generation = await claimReviewGeneration(env, traceId, { repoId, prNumber });
  return {
    ...review,
    draft: freshness.draft,
    githubReview: { repoId, prNumber, generation, headSha, owner, repo },
  };
}

/**
 * Settle the claim of a review whose session was not created: `creation` is the refused creation,
 * or absent when creation threw. A 409 without a refusal code means a newer trigger claimed the
 * PR's generation first, so its claim must stand and the review is skipped. After any other
 * failure the claim bumped the fence but no session will ever carry it: it is rolled back so a
 * review still running on the previous generation is not permanently locked out of submitting,
 * and null leaves the failure to the caller.
 */
export async function abandonReview(
  review: AdmittedReview,
  creation?: Extract<SessionCreationResult, { ok: false }>
): Promise<HandlerResult | null> {
  const { env, log, traceId, meta, githubReview } = review;
  if (creation?.status === 409 && creation.code === undefined) {
    log.info("handler.review_superseded", { ...meta, generation: githubReview.generation });
    return { outcome: "skipped", skip_reason: "superseded" };
  }
  await releaseReviewGeneration(env, log, traceId, githubReview);
  return null;
}

/**
 * Retire every older review of the PR, then mark this one in progress on its head. Both steps are
 * best-effort: neither may stop a review whose session already exists.
 */
export async function beginReview(review: AdmittedReview, sessionId: string): Promise<void> {
  const { env, log, traceId, token, userAgent, meta, githubReview } = review;
  await sweepStaleReviews(env, log, traceId, githubReview);
  await postPendingReviewStatus(env, log, traceId, sessionId, token, review, userAgent, meta);
}

/**
 * The code-review prompt fields that come from the review's admission and from the identity that
 * submits it. A configured reviewer App submits the reviews, so a PR the webhook App opened is not
 * a self-review and GitHub accepts its approval; the reviewer App's token is then fetched by the
 * prompt's submission step.
 */
export function reviewPromptFields(env: Env, author: string, review: AdmittedReview | undefined) {
  // startSession hands every review it admitted to the prompt builder.
  if (!review) throw new Error("Review prompt built without an admitted review");
  const reviewerLogin = env.GITHUB_REVIEWER_USERNAME?.trim();
  const submittingLogin = reviewerLogin || env.GITHUB_BOT_USERNAME;
  return {
    headSha: review.headSha,
    isDraft: review.draft,
    isSelfReview: author.toLowerCase() === submittingLogin.toLowerCase(),
    hasReviewerApp: Boolean(reviewerLogin),
  };
}

/**
 * The PR's submission lease for a review's start marker, or null when the marker must not or
 * cannot be written now. Another holder's live lease is waited out for a few seconds: holders
 * release right after their own writes.
 */
async function acquireStartMarkerLease(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  meta: Record<string, unknown>
): Promise<StartMarkerGrant | null> {
  const giveUpAt = Date.now() + START_MARKER_LEASE_WAIT_MS;
  // On setTimeout rather than AbortSignal.timeout, so it runs on the same clock as the retries.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Start-marker lease wait ran out", "TimeoutError")),
    START_MARKER_LEASE_WAIT_MS
  );
  try {
    for (;;) {
      let result: StartMarkerLeaseResult;
      try {
        result = await requestStartMarkerLease(env, traceId, sessionId, deadline.signal);
      } catch (error) {
        log.warn("review_status.lease_request_failed", {
          ...meta,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return null;
      }
      switch (result.outcome) {
        case "granted":
          return result.grant;
        case "superseded":
          log.info("review_status.superseded", meta);
          return null;
        case "request_failed":
          log.warn("review_status.lease_request_failed", { ...meta, status: result.status });
          return null;
        case "busy":
          if (Date.now() + START_MARKER_LEASE_RETRY_MS > giveUpAt) {
            log.warn("review_status.lease_busy", meta);
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, START_MARKER_LEASE_RETRY_MS));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a just-admitted review as in progress. The start marker is written like every other status
 * on a review's head: holding the PR's submission lease, which is granted only while this review
 * is still its PR's latest and its turn has not been closed out. So a review superseded or closed
 * out before it gets here writes none. And none lands after its review's close-out has read the
 * head — that close-out would finalize the review's fence and leave "pending" behind for good —
 * given that GitHub lands a write within the request timeout or never: the assumption
 * leaseWriteDeadline, a close-out's write deadline too, rests on.
 *
 * Best-effort, as the start marker always was: when the lease cannot be had, the review runs
 * without one, and its verdict or close-out still writes the terminal status.
 */
async function postPendingReviewStatus(
  env: Env,
  log: Logger,
  traceId: string,
  sessionId: string,
  token: string,
  target: ReviewStatusTarget,
  userAgent: string,
  meta: Record<string, unknown>
): Promise<void> {
  const statusMeta = { ...meta, head_sha: target.headSha, state: "pending" };
  const grant = await acquireStartMarkerLease(env, log, traceId, sessionId, statusMeta);
  if (!grant) return;
  // Like a close-out's write, never started so late that it could land after the lease expires.
  if (Date.now() > leaseWriteDeadline(grant)) {
    log.warn("review_status.lease_budget_exhausted", statusMeta);
    await releaseStartMarkerLease(env, log, traceId, sessionId, grant.grantId);
    return;
  }

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
  // Released once GitHub has settled the write: landed it, or refused it with a 4xx. After a 5xx,
  // a transport error or a timeout the write may still land, so the lease is left to expire: a
  // close-out then reads the head only once the write has landed or never will.
  const settled =
    result.ok || (result.status !== undefined && result.status >= 400 && result.status < 500);
  if (settled) {
    await releaseStartMarkerLease(env, log, traceId, sessionId, grant.grantId);
  }
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
export async function sendReviewPrompt(
  review: AdmittedReview,
  sessionId: string,
  message: { content: string; authorId: string }
): Promise<string> {
  const { env, log, traceId, owner, repo, prNumber, headSha } = review;
  const callbackContext: GitHubReviewCallbackContext = {
    source: "github",
    owner,
    repo,
    prNumber,
    headSha,
  };
  try {
    return await sendPrompt(env, traceId, sessionId, { ...message, callbackContext });
  } catch (error) {
    if (error instanceof PromptRejectedError) {
      await closeOutReviewStatus(env, log, traceId, {
        sessionId,
        request: { owner, repo, description: REVIEW_START_FAILED_DESCRIPTION },
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
 * mid-submission, a granted close-out that has read "pending", or a review's start marker — can
 * land its write after the skip, because GitHub statuses have no compare-and-swap. The head then
 * shows that review's own verdict, or its close-out's error, instead of the skip; a start marker's
 * "pending" is replaced by the close-out this sweep records, which is granted only once the start
 * marker's lease is released or has expired. Only a same-head review can do this, and only within
 * one lease TTL of the claim.
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
