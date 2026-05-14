import { createAdminDbClient } from "@harkness-helper/db/admin";
import { getCurrentAdminEmail } from "@/lib/auth/admin";
import { GrantAdminForm } from "./GrantAdminForm";
import { RevokeButton } from "./RevokeButton";

export default async function AdminAdminsPage() {
  const me = await getCurrentAdminEmail();
  const admin = createAdminDbClient();

  const { data: rows } = await admin
    .from("admins")
    .select("*")
    .order("active", { ascending: false })
    .order("granted_at", { ascending: true });

  const all = rows ?? [];
  const active = all.filter((r) => r.active);
  const revoked = all.filter((r) => !r.active);

  const requiredDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim().toLowerCase();

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admins</h1>
        <p className="mt-1 text-sm text-cool-gray">
          Anyone listed below as <strong>active</strong> can sign in to{" "}
          <code>/admin</code>. Email match is case-insensitive against the
          user&rsquo;s Google email.
        </p>
      </div>

      <GrantAdminForm requiredDomain={requiredDomain ?? null} />

      <section className="rounded-md border border-stone-200 bg-white">
        <header className="border-b border-stone-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-cool-gray">
          Active ({active.length})
        </header>
        {active.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-cool-gray">
            No active admins.
          </div>
        ) : (
          <ul className="divide-y divide-stone-100">
            {active.map((r) => (
              <li
                key={r.email}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">
                    {r.email}
                    {r.email === me && (
                      <span className="ml-2 rounded-full bg-dark-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-dark-blue">
                        you
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-cool-gray">
                    Granted {formatDate(r.granted_at)}
                    {r.granted_by_email && r.granted_by_email !== "system" && (
                      <> by {r.granted_by_email}</>
                    )}
                    {r.granted_by_email === "system" && (
                      <> via INITIAL_ADMIN_EMAIL bootstrap</>
                    )}
                  </div>
                </div>
                {r.email === me ? (
                  <span className="text-[11px] text-stone-400">
                    (revoke yourself elsewhere)
                  </span>
                ) : (
                  <RevokeButton email={r.email} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section className="rounded-md border border-stone-200 bg-stone-50">
          <header className="border-b border-stone-200 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-cool-gray">
            Revoked ({revoked.length})
          </header>
          <ul className="divide-y divide-stone-200">
            {revoked.map((r) => (
              <li
                key={r.email}
                className="px-4 py-2.5 text-sm text-cool-gray"
              >
                <div className="truncate">{r.email}</div>
                <div className="text-[11px]">
                  Granted {formatDate(r.granted_at)} &middot; revoked
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
