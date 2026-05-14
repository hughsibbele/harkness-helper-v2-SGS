import { NextResponse, type NextRequest } from "next/server";
import { getServerDbClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await getServerDbClient();
  await supabase.auth.signOut();

  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url, { status: 303 });
}
