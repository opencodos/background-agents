import type { GitHubReviewPublicationRequest } from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

export type GitHubReviewPublicationState = "pending" | "completed" | "failed" | "uncertain";

export interface GitHubReviewPublicationRecord {
  publicationKey: string;
  providerReviewId: string | null;
  repositoryExternalId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  sourceSessionId: string;
  sourceMessageId: string;
  result: GitHubReviewPublicationRequest["result"];
  state: GitHubReviewPublicationState;
  marker: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PublicationRow {
  publication_key: string;
  provider_review_id: string | null;
  repository_external_id: string;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  head_sha: string;
  source_session_id: string;
  source_message_id: string;
  result: GitHubReviewPublicationRequest["result"];
  state: GitHubReviewPublicationState;
  marker: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: PublicationRow): GitHubReviewPublicationRecord {
  return {
    publicationKey: row.publication_key,
    providerReviewId: row.provider_review_id,
    repositoryExternalId: row.repository_external_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    result: row.result,
    state: row.state,
    marker: row.marker,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GitHubReviewPublicationStore {
  constructor(private readonly db: SqlDatabase) {}

  async begin(record: Omit<GitHubReviewPublicationRecord, "providerReviewId" | "state" | "error">) {
    const insert = await this.db
      .prepare(
        `INSERT OR IGNORE INTO github_review_publications (
           publication_key, repository_external_id, repo_owner, repo_name,
           pr_number, head_sha, source_session_id, source_message_id,
           result, state, marker, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .bind(
        record.publicationKey,
        record.repositoryExternalId,
        record.repoOwner,
        record.repoName,
        record.prNumber,
        record.headSha,
        record.sourceSessionId,
        record.sourceMessageId,
        record.result,
        record.marker,
        record.createdAt,
        record.updatedAt
      )
      .run();
    const stored = await this.getBySource(record.sourceSessionId, record.sourceMessageId);
    if (!stored) throw new Error("GitHub review publication was not persisted");
    return { record: stored, created: insert.meta.changes === 1 };
  }

  async get(publicationKey: string): Promise<GitHubReviewPublicationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM github_review_publications WHERE publication_key = ?")
      .bind(publicationKey)
      .first<PublicationRow>();
    return row ? toRecord(row) : null;
  }

  async getByProviderReviewId(
    providerReviewId: string
  ): Promise<GitHubReviewPublicationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM github_review_publications WHERE provider_review_id = ?")
      .bind(providerReviewId)
      .first<PublicationRow>();
    return row ? toRecord(row) : null;
  }

  async getBySource(
    sourceSessionId: string,
    sourceMessageId: string
  ): Promise<GitHubReviewPublicationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM github_review_publications
         WHERE source_session_id = ? AND source_message_id = ?`
      )
      .bind(sourceSessionId, sourceMessageId)
      .first<PublicationRow>();
    return row ? toRecord(row) : null;
  }

  complete(publicationKey: string, providerReviewId: string, updatedAt: number): Promise<unknown> {
    return this.transition(publicationKey, "completed", updatedAt, providerReviewId, null);
  }

  fail(publicationKey: string, error: string, updatedAt: number): Promise<unknown> {
    return this.transition(publicationKey, "failed", updatedAt, null, error);
  }

  markUncertain(publicationKey: string, error: string, updatedAt: number): Promise<unknown> {
    return this.transition(publicationKey, "uncertain", updatedAt, null, error);
  }

  async reconcileComplete(
    publicationKey: string,
    providerReviewId: string,
    updatedAt: number
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_publications
         SET state = 'completed', provider_review_id = ?, error = NULL, updated_at = ?
         WHERE publication_key = ? AND state IN ('pending', 'uncertain')`
      )
      .bind(providerReviewId, updatedAt, publicationKey)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`GitHub review publication cannot be reconciled: ${publicationKey}`);
    }
  }

  private async transition(
    publicationKey: string,
    state: Exclude<GitHubReviewPublicationState, "pending">,
    updatedAt: number,
    providerReviewId: string | null,
    error: string | null
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_publications
         SET state = ?, provider_review_id = COALESCE(?, provider_review_id),
             error = ?, updated_at = ?
         WHERE publication_key = ? AND state = 'pending'`
      )
      .bind(state, providerReviewId, error, updatedAt, publicationKey)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`GitHub review publication is no longer pending: ${publicationKey}`);
    }
  }
}
