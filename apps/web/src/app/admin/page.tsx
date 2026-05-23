import Link from "next/link";

export default function AdminHome() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin console</h1>
        <p className="mt-1 text-sm text-cool-gray">
          School-wide settings. Changes here affect every teacher using
          Harkness Helper at EHS.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Tile
          href="/admin/prompts"
          title="Prompts"
          description="Edit the system prompts the pipeline uses at each stage — transcription, group feedback summary, speaker identification, individual feedback. Changes propagate to the next discussion processed."
        />
        <Tile
          href="/admin/retention"
          title="Retention"
          description="Automated daily sweep that archives stuck uploads and hard-deletes discussions past the retention window. Check that the cron is firing and trigger an out-of-band sweep."
        />
        <Tile
          href="/admin/admins"
          title="Admins"
          description="Grant or revoke admin access. The last active admin can't be revoked."
        />
      </div>
    </div>
  );
}

function Tile({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-md border border-stone-200 bg-white p-5 transition-colors hover:border-dark-blue/40 hover:bg-stone-50"
    >
      <div className="text-sm font-semibold text-stone-900 group-hover:text-dark-blue">
        {title} &rarr;
      </div>
      <p className="mt-1 text-xs leading-relaxed text-cool-gray">
        {description}
      </p>
    </Link>
  );
}
