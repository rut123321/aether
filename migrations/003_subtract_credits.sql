-- Atomic admin credit subtraction. Avoids read-modify-write races.
-- Caps at 0 (never lets balance go negative).
-- Returns the new balance, or NULL if the key does not exist.

create or replace function public.subtract_credits(p_key text, p_amount bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance bigint;
begin
  update public.api_keys
     set credits = greatest(0, credits - p_amount)
   where key = p_key
   returning credits into new_balance;

  return new_balance;
end;
$$;

revoke all on function public.subtract_credits(text, bigint) from public, anon, authenticated;
grant execute on function public.subtract_credits(text, bigint) to service_role;
