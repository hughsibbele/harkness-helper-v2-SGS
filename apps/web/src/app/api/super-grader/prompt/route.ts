import { NextResponse } from "next/server";
import { checkSuperGraderBearer } from "@/lib/peers/auth";
import { createAdminDbClient } from "@harkness-helper/db/admin";

const VALID_PURPOSES = [
  "transcription",
  "summary",
  "speaker_identification",
  "individual_feedback",
] as const;
type ValidPurpose = (typeof VALID_PURPOSES)[number];

function isValidPurpose(k: string): k is ValidPurpose {
  return (VALID_PURPOSES as readonly string[]).includes(k);
}

/**
 * Pull-on-view prompt fetcher. Super-grader renders satellite-owned prompts
 * (read-only from its side) by fetching live from us. Matches the shape
 * super-grader's fetchLivePrompt expects: { body, version, updated_at }.
 *
 * `?key=` maps directly to HK's `prompts.purpose` (4 valid values). HK has
 * no `version` column on prompts, so the response derives version from
 * updated_at as epoch seconds — strictly increasing per save, which is all
 * super-grader's cache uses it for.
 */
export async function GET(request: Request) {
  const authFail = checkSuperGraderBearer(request);
  if (authFail) return authFail;

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }
  if (!isValidPurpose(key)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminDbClient();
  const { data: row } = await admin
    .from("prompts")
    .select("body, updated_at")
    .eq("scope", "system")
    .eq("purpose", key)
    .eq("is_default", true)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const version = Math.floor(new Date(row.updated_at).getTime() / 1000);

  return NextResponse.json(
    { body: row.body, version, updated_at: row.updated_at },
    { headers: { "Cache-Control": "private, max-age=600" } },
  );
}
