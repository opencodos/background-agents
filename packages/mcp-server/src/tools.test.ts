import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "./client";
import { TOOLS, type ToolDefinition } from "./tools";

function tool(name: string): ToolDefinition {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

/** A preview as the control plane returns it, trimmed to what the tools read. */
function preview(overrides: Record<string, unknown> = {}) {
  return {
    name: "deploy-service",
    description: "How to deploy",
    nameAvailable: true,
    revisionSha256: "r".repeat(64),
    totalBytes: 512,
    source: {
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      resolvedRef: "main",
      commitSha: "c".repeat(40),
      subdirectory: "skills/deploy",
      sourceSha256: "s".repeat(64),
    },
    warnings: [{ code: "name-derived", message: "Name taken from frontmatter" }],
    files: [{ path: "SKILL.md", content: "# Deploy\n", sizeBytes: 10, executable: false }],
    ...overrides,
  };
}

function storedSkill(overrides: Record<string, unknown> = {}) {
  return {
    skill: {
      id: "skill_1",
      name: "deploy-service",
      description: "How to deploy",
      enabled: true,
      currentRevisionId: "skillrev_2",
      revisionNumber: 2,
      source: { commitSha: "a".repeat(40), repoOwner: "acme", repoName: "skills" },
      body: "# Deploy\n",
      files: [{ path: "SKILL.md", content: "# Deploy\n" }],
      ...overrides,
    },
  };
}

function fakeClient(handlers: {
  get?: (path: string, query?: unknown) => unknown;
  post?: (path: string, body?: unknown, options?: unknown) => unknown;
}) {
  const get = vi.fn(async (path: string, query?: unknown) => handlers.get?.(path, query));
  const post = vi.fn(async (path: string, body?: unknown, options?: unknown) =>
    handlers.post?.(path, body, options)
  );
  return { client: { get, post } as unknown as ControlPlaneClient, get, post };
}

describe("tool surface", () => {
  it("lists every tool over a real transport, schemas converted and hints set", async () => {
    // tools/list is where a zod shape the SDK cannot convert to JSON Schema
    // actually fails, and where a client reads the write hints. Exercising the
    // real path catches both; constructing the server alone catches neither.
    const { createServer } = await import("./index");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test", version: "0" });
    await Promise.all([
      createServer(fakeClient({}).client).connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    const { tools } = await mcpClient.listTools();
    expect(tools.map((entry) => entry.name).sort()).toEqual(
      TOOLS.map((entry) => entry.name).sort()
    );

    const writes = tools.filter((entry) => entry.annotations?.readOnlyHint === false);
    expect(writes.map((entry) => entry.name).sort()).toEqual([
      "import_skill_from_git",
      "update_skill_from_git",
    ]);
    // Re-import moves the skill's current revision, which is what later
    // sessions load; a client reads this to decide how hard to prompt.
    const hints = Object.fromEntries(
      tools.map((entry) => [entry.name, entry.annotations?.destructiveHint])
    );
    expect(hints.update_skill_from_git).toBe(true);
    expect(hints.import_skill_from_git).toBe(false);
    expect(hints.list_skills).toBe(false);

    // The nested union in the import tool is the shape most likely to fail.
    const importTool = tools.find((entry) => entry.name === "import_skill_from_git");
    expect(importTool?.inputSchema.properties).toHaveProperty("assignments");
    await mcpClient.close();
  });

  it("marks skill import and re-import as the only writes", () => {
    const writes = TOOLS.filter((candidate) => !candidate.readOnly).map(
      (candidate) => candidate.name
    );

    expect(writes.sort()).toEqual(["import_skill_from_git", "update_skill_from_git"]);
  });
});

describe("list_skills", () => {
  it("pages through the catalog with the caller's cursor", async () => {
    const { client, get } = fakeClient({ get: () => ({ skills: [], hasMore: false }) });

    await tool("list_skills").run(client, { limit: 25, cursor: "deploy-service" });

    expect(get).toHaveBeenCalledWith("/skills", { limit: 25, cursor: "deploy-service" });
  });
});

describe("import_skill_from_git", () => {
  it("confirms the import against the digests the preview returned", async () => {
    const { client, post } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
      ref: "main",
      subdirectory: "skills/deploy",
    });

    // Unconfirmed, the control plane would store whatever the source says at
    // apply time rather than what the preview showed.
    expect(post).toHaveBeenLastCalledWith("/skills/import", {
      source: {
        repository: { repoOwner: "acme", repoName: "skills" },
        ref: "main",
        subdirectory: "skills/deploy",
      },
      name: null,
      assignments: [],
      expectedCommitSha: "c".repeat(40),
      expectedSourceSha256: "s".repeat(64),
      expectedRevisionSha256: "r".repeat(64),
    });
  });

  it("passes assignments through, since an unassigned skill loads nowhere", async () => {
    const { client, post } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
      assignments: [{ type: "global" }],
    });

    expect(post).toHaveBeenLastCalledWith(
      "/skills/import",
      expect.objectContaining({ assignments: [{ type: "global" }] })
    );
  });

  it("names the tool that takes over when the skill already exists", async () => {
    const { client, post } = fakeClient({
      post: (path) =>
        path.endsWith("/preview") ? preview({ nameAvailable: false }) : storedSkill(),
    });

    await expect(
      tool("import_skill_from_git").run(client, { repo_owner: "acme", repo_name: "skills" })
    ).rejects.toThrow(/update_skill_from_git/);

    // Refused before the write, not after a 409 from the control plane.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reports file paths rather than file contents", async () => {
    const { client } = fakeClient({
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    const report = (await tool("import_skill_from_git").run(client, {
      repo_owner: "acme",
      repo_name: "skills",
    })) as { files: string[]; skill: Record<string, unknown>; warnings: unknown[] };

    expect(report.files).toEqual(["SKILL.md"]);
    expect(report.skill).not.toHaveProperty("body");
    expect(report.warnings).toHaveLength(1);
  });
});

describe("update_skill_from_git", () => {
  it("pins the re-import to the revision it read, so a concurrent edit loses", async () => {
    const { client, post } = fakeClient({
      get: () => storedSkill({ currentRevisionId: "skillrev_1", revisionNumber: 1 }),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: true },
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill_1", ref: "v2" });

    expect(post).toHaveBeenLastCalledWith(
      "/skills/skill_1/reimport",
      {
        ref: "v2",
        expectedCommitSha: "c".repeat(40),
        expectedSourceSha256: "s".repeat(64),
        expectedRevisionSha256: "r".repeat(64),
      },
      { headers: { "If-Match": '"skillrev_1"' } }
    );
  });

  it("defaults the ref to the one the skill recorded", async () => {
    const { client, post } = fakeClient({
      get: () => storedSkill(),
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill_1" });

    expect(post).toHaveBeenCalledWith("/skills/skill_1/reimport/preview", { ref: null });
  });

  it("surfaces an unchanged source rather than reporting a revision that was not added", async () => {
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { ...storedSkill(), revisionCreated: false },
    });

    const report = (await tool("update_skill_from_git").run(client, { skill_id: "skill_1" })) as {
      revisionCreated: boolean;
      previousRevisionId: string;
    };

    expect(report.revisionCreated).toBe(false);
    expect(report.previousRevisionId).toBe("skillrev_2");
  });

  it("reports the provenance that was stored, not the one that was previewed", async () => {
    // A ref that advanced without changing the generated bytes keeps the old
    // revision and the commit it was recorded at. Reporting the previewed
    // commit would tell the model the skill moved when it did not.
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview")
          ? preview({ source: { ...preview().source, commitSha: "b".repeat(40) } })
          : { ...storedSkill(), revisionCreated: false },
    });

    const report = (await tool("update_skill_from_git").run(client, { skill_id: "skill_1" })) as {
      source: { commitSha: string };
      revisionCreated: boolean;
    };

    expect(report.source.commitSha).toBe("a".repeat(40));
    expect(report.revisionCreated).toBe(false);
  });

  it("falls back to the previewed source when the response records none", async () => {
    const { client } = fakeClient({
      get: () => storedSkill(),
      post: (path) =>
        path.endsWith("/preview") ? preview() : { skill: { ...storedSkill().skill, source: null } },
    });

    const report = (await tool("update_skill_from_git").run(client, { skill_id: "skill_1" })) as {
      source: { commitSha: string };
    };

    expect(report.source.commitSha).toBe("c".repeat(40));
  });

  it("escapes the skill id into the path", async () => {
    const { client, get } = fakeClient({
      get: () => storedSkill(),
      post: (path) => (path.endsWith("/preview") ? preview() : storedSkill()),
    });

    await tool("update_skill_from_git").run(client, { skill_id: "skill/../1" });

    expect(get).toHaveBeenCalledWith("/skills/skill%2F..%2F1");
  });
});
