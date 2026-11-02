import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("migration 0102: backfill sessions.github_review", () => {
  it("marks fenced GitHub bot sessions as review sessions, and only those", async () => {
    // Every session starts as 0101 leaves a pre-existing row: github_review = 0.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, spawn_source, created_at, updated_at) VALUES
          ('fenced-bot', 'github-bot', 1, 1),
          ('unfenced-bot', 'github-bot', 2, 2),
          ('fenced-user', 'user', 3, 3),
          ('plain-user', 'user', 4, 4)`
      ),
      env.DB.prepare(
        `INSERT INTO github_review_sessions
          (repo_id, pr_number, generation, session_id, head_sha, created_at)
         VALUES (1, 1, 1, 'fenced-bot', 'sha', 1), (1, 2, 1, 'fenced-user', 'sha', 3)`
      ),
    ]);

    const migration = env.TEST_MIGRATIONS.find(
      (candidate) => candidate.name === "0102_backfill_session_github_review.sql"
    );
    if (!migration) throw new Error("Migration 0102 not found in TEST_MIGRATIONS");
    await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));

    const rows = await env.DB.prepare("SELECT id, github_review FROM sessions ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "fenced-bot", github_review: 1 },
      { id: "fenced-user", github_review: 0 },
      { id: "plain-user", github_review: 0 },
      { id: "unfenced-bot", github_review: 0 },
    ]);
  });
});
