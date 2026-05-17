"use server";

import { revalidatePath } from "next/cache";
import {
  CanvasError,
  listActiveTeachingCourses,
  listCourseAssignments,
  listCourseStudentEnrollments,
  normalizeHost,
  type CanvasConfig,
} from "@harkness-helper/canvas";
import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import type { CanvasSyncResult } from "./canvas-sync.types";

function loadCanvasConfig(): CanvasConfig {
  const host = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_API_TOKEN;
  if (!host) {
    throw new Error(
      "CANVAS_BASE_URL is not set. Add it to apps/web/.env.local.",
    );
  }
  if (!token) {
    throw new Error(
      "CANVAS_API_TOKEN is not set. Add it to apps/web/.env.local.",
    );
  }
  return { host: normalizeHost(host), token };
}

export async function syncCanvasCache(): Promise<CanvasSyncResult> {
  const teacher = await getCurrentTeacher();

  let config: CanvasConfig;
  try {
    config = loadCanvasConfig();
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Canvas config error",
    };
  }

  const admin = createAdminDbClient();
  const syncedAt = new Date().toISOString();

  try {
    const courses = await listActiveTeachingCourses(config);

    // Upsert courses
    if (courses.length > 0) {
      const { error } = await admin.from("canvas_course_cache").upsert(
        courses.map((c) => ({
          teacher_id: teacher.id,
          canvas_course_id: String(c.id),
          name: c.name,
          course_code: c.course_code ?? null,
          workflow_state: c.workflow_state,
          start_at: c.start_at ?? null,
          end_at: c.end_at ?? null,
          term_name: c.term?.name ?? null,
          term_start_at: c.term?.start_at ?? null,
          term_end_at: c.term?.end_at ?? null,
          last_synced_at: syncedAt,
        })),
        { onConflict: "teacher_id,canvas_course_id" },
      );
      if (error) {
        return { ok: false, message: `course cache write: ${error.message}` };
      }
    }

    let assignmentCount = 0;
    let studentCount = 0;

    // Sequential per-course to stay under Canvas's concurrency budget. Per
    // course we still parallelize the two reads (assignments + enrollments)
    // — that's only 2 calls, safe.
    for (const c of courses) {
      const [assignments, enrollments] = await Promise.all([
        listCourseAssignments(config, c.id),
        listCourseStudentEnrollments(config, c.id),
      ]);

      if (assignments.length > 0) {
        const { error } = await admin.from("canvas_assignment_cache").upsert(
          assignments.map((a) => ({
            teacher_id: teacher.id,
            canvas_course_id: String(c.id),
            canvas_assignment_id: String(a.id),
            name: a.name,
            description: a.description ?? null,
            due_at: a.due_at ?? null,
            points_possible: a.points_possible ?? null,
            workflow_state: a.workflow_state,
            published: a.published ?? null,
            last_synced_at: syncedAt,
          })),
          { onConflict: "teacher_id,canvas_assignment_id" },
        );
        if (error) {
          return {
            ok: false,
            message: `assignment cache write (course ${c.id}): ${error.message}`,
          };
        }
        assignmentCount += assignments.length;
      }

      // Roster: dedupe by user.id (a student in two sections appears twice).
      const seen = new Set<number>();
      const students: { canvas_user_id: string; name: string; email: string | null }[] = [];
      for (const e of enrollments) {
        if (!e.user || seen.has(e.user.id)) continue;
        seen.add(e.user.id);
        students.push({
          canvas_user_id: String(e.user.id),
          name: e.user.name,
          email: e.user.email ?? e.user.login_id ?? null,
        });
      }
      const { error: rosterError } = await admin.from("course_rosters").upsert(
        {
          teacher_id: teacher.id,
          canvas_course_id: String(c.id),
          students,
          last_synced_at: syncedAt,
        },
        { onConflict: "teacher_id,canvas_course_id" },
      );
      if (rosterError) {
        return {
          ok: false,
          message: `roster write (course ${c.id}): ${rosterError.message}`,
        };
      }
      studentCount += students.length;
    }

    const { error: teacherError } = await admin
      .from("teachers")
      .update({ last_canvas_sync_at: syncedAt })
      .eq("id", teacher.id);
    if (teacherError) {
      return {
        ok: false,
        message: `teacher last_canvas_sync_at write: ${teacherError.message}`,
      };
    }

    revalidatePath("/dashboard");

    return {
      ok: true,
      courses: courses.length,
      assignments: assignmentCount,
      students: studentCount,
      syncedAt,
    };
  } catch (err) {
    if (err instanceof CanvasError) {
      return {
        ok: false,
        message: `Canvas API error (${err.status}): ${err.message}`,
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Unknown sync error",
    };
  }
}
