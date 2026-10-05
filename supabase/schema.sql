create extension if not exists pgcrypto;

create table if not exists public.org_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null check (role in ('viewer', 'admin')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_state (
  id smallint primary key check (id = 1),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.org_view_links (
  id smallint primary key check (id = 1),
  token_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

insert into public.org_state (id, state)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

do $$
begin
  alter publication supabase_realtime add table public.org_state;
exception when duplicate_object then
  null;
end;
$$;

create or replace function public.is_org_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where user_id = (select auth.uid())
  );
$$;

create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where user_id = (select auth.uid()) and role = 'admin'
  );
$$;

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

drop trigger if exists org_members_admin_limit on public.org_members;
create trigger org_members_admin_limit
before insert or update of role, email on public.org_members
for each row execute function public.enforce_org_admin_limit();

alter table public.org_members enable row level security;
alter table public.org_state enable row level security;
alter table public.org_view_links enable row level security;

revoke all on public.org_members from anon, authenticated;
revoke all on public.org_state from anon, authenticated;
revoke all on public.org_view_links from anon, authenticated;
grant select on public.org_members to authenticated;
grant select on public.org_state to authenticated;
grant update (state, updated_at, updated_by) on public.org_state to authenticated;
grant execute on function public.is_org_member() to authenticated;
grant execute on function public.is_org_admin() to authenticated;

drop policy if exists "members can see own access" on public.org_members;
create policy "members can see own access"
on public.org_members for select to authenticated
using (user_id = (select auth.uid()) or public.is_org_admin());

drop policy if exists "shared users can read directory" on public.org_state;
create policy "shared users can read directory"
on public.org_state for select to authenticated
using (public.is_org_member());

drop policy if exists "admins can update directory" on public.org_state;
create policy "admins can update directory"
on public.org_state for update to authenticated
using (public.is_org_admin())
with check (public.is_org_admin());

-- Run once in Supabase SQL Editor BEFORE deploying the updated manage-sharing.
-- Preserve the current link hash and all directory/account data.
begin;

-- Kept only in this protected table so authenticated admins can copy the SAME
-- link on another device via the Edge Function. Browsers cannot read this table.
alter table public.org_view_links add column if not exists token_value text;
alter table public.org_view_links enable row level security;
revoke all on public.org_view_links from anon, authenticated;

-- Re-enable the current link if the old interface had revoked it.
update public.org_view_links set active = true where id = 1 and not active;

create or replace function public.protect_permanent_view_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'The permanent viewer link cannot be deleted.';
  end if;
  if new.id is distinct from old.id
     or new.token_hash is distinct from old.token_hash
     or (old.token_value is not null and new.token_value is distinct from old.token_value)
     or not new.active then
    raise exception 'The permanent viewer link cannot be rotated or revoked.';
  end if;
  -- Validate the one-time adoption of an existing link, including direct writes.
  if new.token_value is not null and (
       length(new.token_value) < 40
       or length(new.token_value) > 100
       or encode(sha256(convert_to(new.token_value, 'UTF8')), 'hex') <> new.token_hash
     ) then
    raise exception 'The saved viewer token must match the existing link hash.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_permanent_view_link on public.org_view_links;
create trigger protect_permanent_view_link
before update or delete on public.org_view_links
for each row execute function public.protect_permanent_view_link();

commit;
