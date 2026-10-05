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
