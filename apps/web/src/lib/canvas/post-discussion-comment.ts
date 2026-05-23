// M7.5 — fan out a draft Canvas comment to each participant in a
// discussion. Called from the Inngest worker after the Drive doc lands.
//
// Per-class granularity: the same draft comment text (carrying the
// Drive doc link) is posted to every participant's submission for the
// discussion's Canvas assignment. Drafts are author-scoped — the
// configured CANVAS_API_TOKEN owner is the author across the suite (HH
// is single-tenant Canvas).
//
// Returns the per-participant outcome aggregate so the worker can
// persist `canvas_comment_post_status` + `canvas_comment_error`. Best-
// effort: never throws — partial failures land in the aggregate.

import { postTeacherDraftComment } from "@harkness-helper/canvas";
import { createAdminDbClient } from "@harkness-helper/db/admin";

type PostOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "posted";
      posted_for: string[]; // canvas_user_ids
      failed: { canvas_user_id: string; error: string }[];
    };

export async function postDiscussionDraftComments(args: {
  discussionId: string;
  driveDocUrl: string;
}): Promise<PostOutcome> {
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_API_TOKEN;
  if (!baseUrl || !token) {
    return {
      kind: "skipped",
      reason: "CANVAS_BASE_URL / CANVAS_API_TOKEN unset",
    };
  }

  const admin = createAdminDbClient();

  // Load discussion + per-teacher enabled flag + participants in one
  // round-trip.
  const { data: discussion, error: discErr } = await admin
    .from("discussions")
    .select("id, canvas_assignment_id, canvas_course_id, teacher_id, teachers!inner(canvas_comment_enabled)")
    .eq("id", args.discussionId)
    .single();
  if (discErr || !discussion) {
    return {
      kind: "skipped",
      reason: `discussion lookup: ${discErr?.message ?? "not found"}`,
    };
  }
  type TeacherJoin = { canvas_comment_enabled: boolean };
  const teacher = Array.isArray(discussion.teachers)
    ? (discussion.teachers[0] as TeacherJoin | undefined)
    : (discussion.teachers as TeacherJoin | null);
  if (!teacher?.canvas_comment_enabled) {
    return { kind: "skipped", reason: "canvas_comment_enabled is false" };
  }

  const { data: participations, error: partErr } = await admin
    .from("participations")
    .select("students!inner ( canvas_user_id )")
    .eq("discussion_id", args.discussionId);
  if (partErr) {
    return {
      kind: "skipped",
      reason: `participations lookup: ${partErr.message}`,
    };
  }

  type Row = {
    students:
      | { canvas_user_id: string }
      | { canvas_user_id: string }[]
      | null;
  };
  const seen = new Set<string>();
  const canvasUserIds = ((participations ?? []) as unknown as Row[])
    .map((r) => {
      const s = Array.isArray(r.students) ? r.students[0] : r.students;
      return s?.canvas_user_id ?? null;
    })
    .filter((id): id is string => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  if (canvasUserIds.length === 0) {
    return { kind: "skipped", reason: "no participants" };
  }

  const config = {
    host: baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    token,
  };
  const text = composeCommentText(args.driveDocUrl);

  const posted_for: string[] = [];
  const failed: { canvas_user_id: string; error: string }[] = [];
  for (const canvasUserId of canvasUserIds) {
    try {
      await postTeacherDraftComment(
        config,
        discussion.canvas_course_id,
        discussion.canvas_assignment_id,
        canvasUserId,
        text,
      );
      posted_for.push(canvasUserId);
    } catch (err) {
      failed.push({
        canvas_user_id: canvasUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "posted", posted_for, failed };
}

function composeCommentText(driveDocUrl: string): string {
  return [
    "Harkness Helper has transcribed this discussion.",
    "",
    `Transcript + summary: ${driveDocUrl}`,
    "",
    "(This is a draft comment — only visible to me until I publish.)",
  ].join("\n");
}
