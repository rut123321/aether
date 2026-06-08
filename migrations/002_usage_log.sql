-- Usage log: record each billable proxy request so users can see history.
-- Run in Supabase SQL Editor.

create table if not exists public.usage_log (
  id          bigserial primary key,
  key         text not null references public.api_keys(key) on delete cascade,
  model       text,
  tokens      bigint not null default 0,
  credits     bigint not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists usage_log_key_time_idx
  on public.usage_log (key, created_at desc);

alter table public.usage_log enable row level security;
-- service_role bypasses RLS, so no policies needed for server access.
