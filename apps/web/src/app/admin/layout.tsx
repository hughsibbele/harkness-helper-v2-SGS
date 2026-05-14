import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import { BrandHeader } from "@/components/BrandHeader";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Order matters: getCurrentTeacher() redirects unauthed users to "/".
  // Then check admin status; non-admin teachers go back to /dashboard.
  const teacher = await getCurrentTeacher();
  const adminEmail = await getCurrentAdminEmail();
  if (!adminEmail) redirect("/dashboard");

  const nav = (
    <nav className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 text-sm">
      <Link
        href="/admin/prompts"
        className="text-ink transition-colors hover:text-dark-blue"
      >
        Transcription prompt
      </Link>
      <Link
        href="/admin/admins"
        className="text-ink transition-colors hover:text-dark-blue"
      >
        Admins
      </Link>
      <Link
        href="/dashboard"
        className="text-cool-gray transition-colors hover:text-maroon"
      >
        ← Dashboard
      </Link>
      <span className="text-xs italic text-cool-gray" title={teacher.email}>
        {teacher.display_name}
      </span>
      <form action="/auth/logout" method="post">
        <button
          type="submit"
          className="text-xs italic text-cool-gray transition-colors hover:text-maroon"
        >
          Sign out
        </button>
      </form>
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {/* Dark-blue rule (vs. light-blue on /dashboard) so admin sessions feel
          visually distinct. */}
      <BrandHeader
        logoHref="/admin"
        ruleClassName="h-0.5 border-0 bg-dark-blue"
        right={nav}
      />
      <main className="flex-1 px-6 py-8">{children}</main>
      <footer className="border-t border-light-blue/40 bg-white/50 px-6 py-3 text-center text-xs italic text-cool-gray">
        Harkness Helper v2 &middot; Admin &middot; Episcopal High School
      </footer>
    </div>
  );
}
