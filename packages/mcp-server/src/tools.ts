/**
 * The tool surface.
 *
 * Reads are one GET each against a route whose policy already accepts an
 * access-token principal. The two skill-writing tools are the only mutations,
 * and they reach only the import routes that opted a token into writing; the
 * control plane refuses this credential every other mutating method.
 */

import { SKILL_LIST_PAGE_SIZE } from "@open-inspect/shared/types/skills";
import { z } from "zod";
import type { ControlPlaneClient } from "./client";

/**
 * Page caps, matching what the control-plane handlers themselves enforce.
 * Asking past a server cap is silently clamped, which reads as a short page
 * and invites the model to conclude there is nothing more.
 */
const MAX_EVENT_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 100;

const MAX_MESSAGE_LIMIT = 100;

const MAX_SESSION_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 20;

/** Every paged tool takes the same continuation argument. */
const cursor = z
  .string()
  .optional()
  .describe("Continuation cursor from a previous page of this same call");

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Drives the MCP `readOnlyHint`, which is how a client decides what to prompt for. */
  readOnly: boolean;
  /**
   * Drives the MCP `destructiveHint`, which means additive-only when false.
   * Set it on a write that replaces something a later reader will act on, even
   * where the previous value remains recoverable. Meaningless on a read tool.
   */
  destructive?: true;
  inputSchema: z.ZodRawShape;
  run(client: ControlPlaneClient, args: Record<string, unknown>): Promise<unknown>;
}

const sessionId = z.string().min(1).describe("Session id, as returned by list_sessions");

/**
 * The preview fields a confirmation needs, read leniently.
 *
 * `z.object` rather than the control plane's own `strictObject` schema: this
 * server is built on a laptop and talks to a deployment that may be a version
 * ahead, and an unrecognized field is no reason to fail an import.
 */
const importPreviewSchema = z.object({
  name: z.string(),
  description: z.string(),
  nameAvailable: z.boolean(),
  revisionSha256: z.string(),
  totalBytes: z.number(),
  source: z.object({
    provider: z.string(),
    repoOwner: z.string(),
    repoName: z.string(),
    resolvedRef: z.string(),
    commitSha: z.string(),
    subdirectory: z.string().nullable(),
    sourceSha256: z.string(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  files: z.array(z.object({ path: z.string() })).default([]),
});

type ImportPreview = z.infer<typeof importPreviewSchema>;

/** The identity of a stored skill, without the revision content. */
const storedSkillSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    currentRevisionId: z.string(),
    revisionNumber: z.number(),
    /**
     * Recorded provenance, passed through as the control plane sent it rather
     * than narrowed to a shape this build knows — every field of it is a fact
     * about what is stored, and dropping one would report less than is known.
     */
    source: z.unknown().optional(),
  }),
});

function parsePreview(value: unknown): ImportPreview {
  const parsed = importPreviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Control plane returned an unrecognized import preview: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function parseStoredSkill(value: unknown): z.infer<typeof storedSkillSchema>["skill"] {
  const parsed = storedSkillSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Control plane returned an unrecognized skill: ${parsed.error.message}`);
  }
  return parsed.data.skill;
}

/**
 * Pin a confirmation to the bytes the preview showed.
 *
 * The control plane re-reads the source when it applies an import and refuses
 * to store anything that no longer matches these digests. Previewing and
 * confirming in one tool call leaves only a race to catch, and a moved source
 * surfaces as a 409 rather than as an unreviewed import.
 */
function confirmation(preview: ImportPreview): Record<string, string> {
  return {
    expectedCommitSha: preview.source.commitSha,
    expectedSourceSha256: preview.source.sourceSha256,
    expectedRevisionSha256: preview.revisionSha256,
  };
}

/** What both write tools report back, without the skill body or file contents. */
function importReport(
  skill: z.infer<typeof storedSkillSchema>["skill"],
  preview: ImportPreview
): Record<string, unknown> {
  const { source, ...identity } = skill;
  return {
    skill: identity,
    // Provenance as stored, never as previewed. A re-import whose content
    // digest is unchanged keeps the revision it had, and the provenance that
    // came with it: reporting the previewed commit there would claim the skill
    // had moved to a commit it was never recorded at.
    source: source ?? preview.source,
    files: preview.files.map((file) => file.path),
    totalBytes: preview.totalBytes,
    warnings: preview.warnings,
  };
}

const repoOwner = z
  .string()
  .min(1)
  .describe(
    "Repository owner. May contain `/` where the provider nests namespaces, as GitLab subgroups do."
  );
const repoName = z.string().min(1).describe("Repository name, a single path segment");
const importRef = z
  .string()
  .min(1)
  .optional()
  .describe("Branch, tag, or commit to read. Defaults to the repository's default branch.");

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_sessions",
    title: "List sessions",
    readOnly: true,
    description:
      "List Open-Inspect sessions, newest first. Use to find a session id before reading its " +
      "events or diff. Filter by status to narrow to active or failed work.",
    inputSchema: {
      status: z
        .enum(["created", "active", "completed", "failed", "archived", "cancelled"])
        .optional()
        .describe("Only sessions in this status. In-flight work is `active`, not `running`."),
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
    },
    run: (client, args) =>
      client.get("/sessions", {
        status: args.status as string | undefined,
        limit: (args.limit as number | undefined) ?? DEFAULT_SESSION_LIMIT,
        offset: args.offset as number | undefined,
      }),
  },
  {
    name: "get_session_events",
    title: "Read a session timeline",
    readOnly: true,
    description:
      "Read one session's event timeline — tool calls, agent output, errors. This is the " +
      "primary tool for working out what a session actually did and where it went wrong. Returns one page; pass the response's cursor back to continue.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/events`, {
        limit: (args.limit as number | undefined) ?? DEFAULT_EVENT_LIMIT,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_messages",
    title: "Read session messages",
    readOnly: true,
    description:
      "Read the prompt/response messages exchanged in one session, without the tool-call " +
      "detail that get_session_events includes.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_MESSAGE_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/messages`, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_diff",
    title: "Read a session's diff",
    readOnly: true,
    description: "Read the working-tree diff a session produced, as a list of changed files.",
    inputSchema: { session_id: sessionId },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/diff`),
  },
  {
    name: "list_automation_runs",
    title: "List automation invocations",
    readOnly: true,
    description:
      "List one automation's recent invocations with their status. Use to check whether a " +
      "scheduled automation fired, skipped, or failed.",
    inputSchema: {
      automation_id: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
    },
    run: (client, args) =>
      client.get(`/automations/${encodeURIComponent(args.automation_id as string)}/invocations`, {
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_automation_run",
    title: "Read one automation run",
    readOnly: true,
    description:
      "Read a single automation invocation, including the child sessions it launched. Pair " +
      "with get_session_events on a child id to see what that run actually did.",
    inputSchema: {
      automation_id: z.string().min(1),
      run_id: z.string().min(1),
    },
    run: (client, args) =>
      client.get(
        `/automations/${encodeURIComponent(args.automation_id as string)}` +
          `/runs/${encodeURIComponent(args.run_id as string)}`
      ),
  },
  {
    name: "list_skills",
    title: "List managed skills",
    readOnly: true,
    description:
      "List the installation's managed skills alphabetically. Use to find a skill id before " +
      "updating it, to see which skills are enabled, and to see which repository each was " +
      "imported from. Returns one page; pass the response's nextCursor back to continue.",
    inputSchema: {
      limit: z.number().int().min(1).max(SKILL_LIST_PAGE_SIZE).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get("/skills", {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "import_skill_from_git",
    title: "Create a skill from a repository",
    readOnly: false,
    description:
      "Create a managed skill from a SKILL.md in a Git repository. Previews the source and " +
      "stores it in one step. Fails if a skill of that name already exists — use " +
      "update_skill_from_git to re-import that one instead. The skill is created enabled, but " +
      "its assignments are what decide which sessions load it.",
    inputSchema: {
      repo_owner: repoOwner,
      repo_name: repoName,
      ref: importRef,
      subdirectory: z
        .string()
        .optional()
        .describe("Directory holding SKILL.md, relative to the repository root"),
      name: z
        .string()
        .optional()
        .describe("Overrides the name derived from the source's own frontmatter"),
      assignments: z
        .array(
          z.union([
            z.object({ type: z.literal("global") }),
            z.object({
              type: z.literal("repository"),
              repository: z.object({ repoOwner, repoName }),
            }),
            z.object({ type: z.literal("environment"), environmentId: z.string().min(1) }),
          ])
        )
        .optional()
        .describe(
          "Where the skill applies. Omitted, it is stored unassigned and no session loads it."
        ),
    },
    run: async (client, args) => {
      const source = {
        repository: { repoOwner: args.repo_owner as string, repoName: args.repo_name as string },
        ref: (args.ref as string | undefined) ?? null,
        subdirectory: (args.subdirectory as string | undefined) ?? null,
      };
      const name = (args.name as string | undefined) ?? null;

      const preview = parsePreview(await client.post("/skills/import/preview", { source, name }));
      if (!preview.nameAvailable) {
        // Importing would 409 on the name. Say which tool takes it from here
        // rather than making the model read that out of a status code.
        throw new Error(
          `A skill named "${preview.name}" already exists. Find its id with list_skills and ` +
            "call update_skill_from_git to re-import it, or pass a different name."
        );
      }

      const imported = await client.post("/skills/import", {
        source,
        name,
        assignments: (args.assignments as unknown[] | undefined) ?? [],
        ...confirmation(preview),
      });
      return importReport(parseStoredSkill(imported), preview);
    },
  },
  {
    name: "update_skill_from_git",
    title: "Update a skill from its repository",
    readOnly: false,
    // Not additive: this moves the skill's current revision, and that is what
    // future sessions load. The old revision surviving in the history makes it
    // recoverable, not additive.
    destructive: true,
    description:
      "Re-import an existing skill from the repository it was imported from, adding a revision " +
      "with whatever the source says now. The repository and subdirectory come from the skill's " +
      "recorded provenance; only the ref may move. Reports revisionCreated false when the source " +
      "had not changed. Fails on a skill that was authored in the editor rather than imported. " +
      "Reads the skill before writing it, so it needs skills.read alongside skills.manage.",
    inputSchema: {
      skill_id: z.string().min(1).describe("Skill id, as returned by list_skills"),
      ref: importRef,
    },
    run: async (client, args) => {
      const skillId = encodeURIComponent(args.skill_id as string);
      const ref = (args.ref as string | undefined) ?? null;

      // Read the revision first: it is the If-Match the re-import needs, and
      // pinning it here means a concurrent edit fails the write rather than
      // silently losing itself in a new revision.
      const current = parseStoredSkill(await client.get(`/skills/${skillId}`));
      const preview = parsePreview(
        await client.post(`/skills/${skillId}/reimport/preview`, { ref })
      );

      const applied = await client.post(
        `/skills/${skillId}/reimport`,
        { ref, ...confirmation(preview) },
        { headers: { "If-Match": `"${current.currentRevisionId}"` } }
      );
      const revisionCreated =
        typeof applied === "object" && applied !== null && "revisionCreated" in applied
          ? Boolean((applied as { revisionCreated: unknown }).revisionCreated)
          : null;
      return {
        ...importReport(parseStoredSkill(applied), preview),
        previousRevisionId: current.currentRevisionId,
        revisionCreated,
      };
    },
  },
];
