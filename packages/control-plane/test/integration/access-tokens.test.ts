import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/access-tokens";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const USER_ID = "11111111111111111111111111111111";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function seedUser(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`
  )
    .bind(USER_ID, "operator@example.com", Date.now(), Date.now())
    .run();
}

async function issueToken(expiresAt: number | null = null): Promise<string> {
  const created = await new PersonalAccessTokenStore(sqlDatabase(env.DB)).create({
    userId: USER_ID,
    name: "laptop",
    expiresAt,
  });
  return created.token;
}

function bearer(token: string, init?: { method?: string }): Promise<Response> {
  return SELF.fetch("https://test.local/sessions", {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("personal access tokens", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedUser();
  });

  it("authenticates a read as the user who issued the token", async () => {
    const response = await bearer(await issueToken());
    expect(response.status).toBe(200);
  });

  it("refuses every mutating method, whatever the route policy allows", async () => {
    // Real routes, each accepting a user-or-service principal: a 403 here is
    // the read-only rule and not a 404 from an unmatched path.
    const mutations = [
      ["POST", "https://test.local/skills"],
      ["PUT", "https://test.local/keyboard-shortcuts"],
      ["PATCH", "https://test.local/sessions/any/read-state"],
      ["DELETE", "https://test.local/sessions/any"],
    ] as const;

    const token = await issueToken();
    for (const [method, url] of mutations) {
      const response = await SELF.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, method).toBe(403);
    }
  });

  async function assignRole(roleId: string): Promise<void> {
    await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(roleId, USER_ID)
      .run();
  }

  function skillRequest(token: string, method: string, path: string): Promise<Response> {
    return SELF.fetch(`https://test.local${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
  }

  describe("skill import, the one write a token may make", () => {
    it("reaches import once the owner holds skills.manage", async () => {
      await assignRole("role_builtin_administrator");
      const token = await issueToken();

      // 400 from the handler's own body validation: admission let it through,
      // which is the whole claim. A 403 here would mean it never arrived.
      const response = await skillRequest(token, "POST", "/skills/import");
      expect(response.status).toBe(400);
    });

    it("refuses an owner whose role lacks skills.manage", async () => {
      // The default role is member. Before access tokens resolved their
      // owner's authorization this passed unchecked, because a principal with
      // no loaded subject waved every permission requirement through.
      await assignRole("role_builtin_member");
      const token = await issueToken();

      const response = await skillRequest(token, "POST", "/skills/import");
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "permission_required",
        permission: "skills.manage",
      });
    });

    it("refuses a suspended owner, whose browser session would be refused too", async () => {
      await assignRole("role_builtin_administrator");
      await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
        .bind(Date.now(), USER_ID)
        .run();
      const token = await issueToken();

      expect((await skillRequest(token, "POST", "/skills/import")).status).toBe(403);
    });

    it("does not carry over to the destructive skill routes", async () => {
      // The exception is four import routes, not `skills.manage` as a whole:
      // an import is recoverable from the revision history and a delete is not.
      // These stay human-only, so they refuse on the principal's kind before
      // the method is even considered.
      await assignRole("role_builtin_administrator");
      const token = await issueToken();

      for (const [method, path] of [
        ["DELETE", "/skills/any"],
        ["PUT", "/skills/any"],
        ["POST", "/skills"],
      ] as const) {
        const response = await skillRequest(token, method, path);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json(), `${method} ${path}`).toMatchObject({
          error: "Human user authentication required",
        });
      }
    });
  });

  it("cannot mint another token, so revocation stays meaningful", async () => {
    // /access-tokens is human-only. A token that could issue itself a
    // successor would survive its own revocation.
    const token = await issueToken();
    const response = await SELF.fetch("https://test.local/access-tokens", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const response = await bearer(await issueToken(Date.now() - MS_PER_DAY));
    expect(response.status).toBe(401);
  });

  it("rejects a token that was revoked", async () => {
    const store = new PersonalAccessTokenStore(sqlDatabase(env.DB));
    const created = await store.create({ userId: USER_ID, name: "laptop", expiresAt: null });
    expect(await store.revoke(USER_ID, created.id)).toBe(true);

    const response = await bearer(created.token);
    expect(response.status).toBe(401);
  });

  it("rejects an unknown token that is nonetheless well formed", async () => {
    const response = await bearer(`${ACCESS_TOKEN_PREFIX}${"0".repeat(64)}`);
    expect(response.status).toBe(401);
  });

  it("stores only a hash, so the table cannot yield a working credential", async () => {
    const token = await issueToken();
    const row = await env.DB.prepare(
      "SELECT token_hash, display_prefix FROM personal_access_tokens WHERE user_id = ?"
    )
      .bind(USER_ID)
      .first<{ token_hash: string; display_prefix: string }>();

    expect(row?.token_hash).not.toBe(token);
    expect(token).not.toContain(row?.token_hash);
    expect(token.startsWith(row?.display_prefix ?? "x")).toBe(true);
  });

  it("records last use, so an unused token is identifiable before revoking it", async () => {
    const token = await issueToken();
    expect(await bearer(token)).toMatchObject({ status: 200 });

    const row = await env.DB.prepare(
      "SELECT last_used_at FROM personal_access_tokens WHERE user_id = ?"
    )
      .bind(USER_ID)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeGreaterThan(0);
  });

  it("does not rewrite last use on every read", async () => {
    // Otherwise each read bills a D1 write, and a polling MCP client turns the
    // read-only path into sustained write load.
    const token = await issueToken();
    await bearer(token);
    const first = await env.DB.prepare(
      "SELECT last_used_at FROM personal_access_tokens WHERE user_id = ?"
    )
      .bind(USER_ID)
      .first<{ last_used_at: number }>();

    await bearer(token);
    const second = await env.DB.prepare(
      "SELECT last_used_at FROM personal_access_tokens WHERE user_id = ?"
    )
      .bind(USER_ID)
      .first<{ last_used_at: number }>();

    expect(second?.last_used_at).toBe(first?.last_used_at);
  });

  it("reads as its owner, so createdBy=me resolves to the issuing user", async () => {
    const token = await issueToken();
    const response = await SELF.fetch("https://test.local/sessions?createdBy=me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it("keeps the plaintext token out of caches", async () => {
    const created = await serviceFetch("https://test.local/access-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "laptop" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("lists and revokes through the human-only routes", async () => {
    const created = await serviceFetch("https://test.local/access-tokens", {
      method: "POST",
      body: JSON.stringify({ name: "laptop" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; token: string; displayPrefix: string };
    expect(body.token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);

    const listed = await serviceFetch("https://test.local/access-tokens");
    const list = (await listed.json()) as { tokens: { id: string; token?: string }[] };
    expect(list.tokens).toHaveLength(1);
    // The plaintext is returned by creation and never again.
    expect(list.tokens[0].token).toBeUndefined();

    const revoked = await serviceFetch(`https://test.local/access-tokens/${body.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    await expect(bearer(body.token)).resolves.toMatchObject({ status: 401 });
  });
});
