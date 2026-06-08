-- API keys storage for Aether endpoint
-- Run this in Supabase SQL Editor (Project → SQL → New query)

create table if not exists public.api_keys (
  key         text primary key,
  name        text not null,
  credits     bigint not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists api_keys_created_at_idx on public.api_keys (created_at desc);

-- RLS: deny all by default. Server uses service_role which bypasses RLS.
alter table public.api_keys enable row level security;

-- Atomic credit deduction. Returns the new balance, or NULL if key not found.
-- Using this avoids read-modify-write races when many requests deduct at once.
create or replace function public.deduct_credits(p_key text, p_amount bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance bigint;
begin
  update public.api_keys
     set credits = credits - p_amount
   where key = p_key
   returning credits into new_balance;

  return new_balance;
end;
$$;

revoke all on function public.deduct_credits(text, bigint) from public, anon, authenticated;
grant execute on function public.deduct_credits(text, bigint) to service_role;
