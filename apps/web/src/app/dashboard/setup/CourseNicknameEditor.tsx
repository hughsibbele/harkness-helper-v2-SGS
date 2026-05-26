"use client";

import { useRef, useState } from "react";
import { updateCourseNickname } from "@/lib/actions/course-nickname";

type Course = {
  canvas_course_id: string;
  name: string;
  course_code: string | null;
  short_name: string | null;
};

export function CourseNicknameEditor({ courses }: { courses: Course[] }) {
  if (courses.length === 0) {
    return (
      <p className="text-sm text-cool-gray">
        No courses synced yet. Sync Canvas from the dashboard first.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {courses.map((c) => (
        <NicknameRow key={c.canvas_course_id} course={c} />
      ))}
    </div>
  );
}

function NicknameRow({ course }: { course: Course }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function save(value: string) {
    // Don't save if unchanged
    if (value.trim() === (course.short_name ?? "")) return;

    setStatus("saving");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const result = await updateCourseNickname(
      course.canvas_course_id,
      value,
    );
    if (result.ok) {
      setStatus("saved");
      timeoutRef.current = setTimeout(() => setStatus("idle"), 2000);
    } else {
      setStatus("error");
      timeoutRef.current = setTimeout(() => setStatus("idle"), 3000);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 truncate text-sm text-stone-500">
        {course.name}
      </span>
      <div className="flex items-center gap-2">
        <input
          defaultValue={course.short_name ?? ""}
          placeholder="e.g. FLC"
          onBlur={(e) => save(e.target.value)}
          className="w-32 rounded border border-stone-300 px-2 py-1 text-sm text-ink placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
        />
        {status === "saving" && (
          <span className="text-xs text-stone-400">saving...</span>
        )}
        {status === "saved" && (
          <span className="text-xs text-emerald-600">saved</span>
        )}
        {status === "error" && (
          <span className="text-xs text-red-600">failed</span>
        )}
      </div>
    </div>
  );
}
