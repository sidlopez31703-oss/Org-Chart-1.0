-- Run once in Supabase SQL Editor to enable public view links and ten admins.
-- This preserves org_members and org_state data.

create table if not exists public.org_view_links (
  id smallint primary key check (id = 1),
  token_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.org_view_links enable row level security;
revoke all on public.org_view_links from anon, authenticated;

create or replace function public.enforce_org_admin_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count integer;
begin
  if new.role = 'admin' and (tg_op = 'INSERT' or old.role is distinct from 'admin') then
    perform pg_advisory_xact_lock(721904221);
    select count(*) into admin_count
    from public.org_members
    where role = 'admin' and user_id <> new.user_id;
    if admin_count >= 10 then
      raise exception 'A maximum of ten org chart administrators is allowed.';
    end if;
  end if;
  new.email := lower(trim(new.email));
  return new;
end;
$$;
