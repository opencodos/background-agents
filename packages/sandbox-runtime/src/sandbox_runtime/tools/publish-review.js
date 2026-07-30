import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

export default tool({
  name: "publish-review",
  description:
    "Publish the completed GitHub code review. Call exactly once, after composing the complete review. The server derives the repository, pull request, commit, session, and message from trusted review-session provenance. Submit all inline findings together; use result=no_findings with no comments when there are no findings.",
  args: {
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
    summary: z.string().min(1),
    result: z.enum(["findings", "no_findings"]),
    comments: z
      .array(
        z.object({
          path: z.string().min(1),
          line: z.number().int().positive(),
          startLine: z.number().int().positive().optional(),
          side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
          startSide: z.enum(["LEFT", "RIGHT"]).optional(),
          body: z.string().min(1),
        })
      )
      .default([]),
  },
  async execute(args) {
    try {
      const response = await bridgeFetch("/github-review", {
        method: "POST",
        body: JSON.stringify(args),
      });
      if (!response.ok) {
        return JSON.stringify({
          ok: false,
          error: await extractError(response, "Review publication failed"),
        });
      }
      return JSON.stringify({ ok: true, ...(await response.json()) });
    } catch (caught) {
      return JSON.stringify({
        ok: false,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  },
});
