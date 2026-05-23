-- M6.22 Phase 0c — retention audit log table.
--
-- One row per /api/cron/sweep-discussions invocation. Counts archive +
-- hard-delete results so the operator can confirm via /admin/retention
-- that the cron is running, without digging through Vercel function logs.

create table public.retention_audits (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  archived_count int not null default 0,
  deleted_count int not null default 0,
  storage_objects_deleted int not null default 0,
  error text,
  triggered_by text not null check (triggered_by in ('cron', 'admin_manual'))
);

alter table public.retention_audits enable row level security;

grant select on public.retention_audits to authenticated;
grant select, insert, update, delete on public.retention_audits to service_role;
-- intentionally no anon grant — admin-only table.

create policy retention_audits_admin_select on public.retention_audits
  for select to authenticated
  using (is_admin());

comment on table public.retention_audits is
  'M6.22 Phase 0c — one row per /api/cron/sweep-discussions invocation. '
  'Counts archive + hard-delete results. Surfaced on /admin/retention.';
