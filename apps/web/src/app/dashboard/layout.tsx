import Link from "next/link";
import { getCurrentTeacher } from "@/lib/auth/teacher";
import { isAdmin } from "@/lib/auth/admin";
import { BrandHeader } from "@/components/BrandHeader";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const teacher = await getCurrentTeacher();
  const showAdminLink = await isAdmin();

  const nav = (
    <nav className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 text-sm">
      <Link
        href="/dashboard"
        className="text-ink transition-colors hover:text-maroon"
      >
        Dashboard
      </Link>
      <Link
        href="/dashboard/setup"
        className="text-ink transition-colors hover:text-maroon"
      >
        Canvas &amp; Drive
      </Link>
      {showAdminLink && (
        <Link
          href="/admin"
          className="text-cool-gray transition-colors hover:text-dark-blue"
        >
          Admin →
        </Link>
      )}
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
      <BrandHeader logoHref="/dashboard" right={nav} />
      <main className="flex-1 px-6 py-8">{children}</main>
      <footer className="border-t border-light-blue/40 bg-white/50 px-6 py-3 text-center text-xs italic text-cool-gray">
        Harkness Helper v2 &middot; Episcopal High School
      </footer>
    </div>
  );
}
