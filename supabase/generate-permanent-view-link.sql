-- Run before deploying the updated manage-sharing function.
-- Keep every existing viewer token valid while enabling automatic generation.
begin;
alter table public.org_view_links add column if not exists token_value text;
alter table public.org_view_links add column if not exists generated_token_hash text;
alter table public.org_view_links enable row level security;
revoke all on public.org_view_links from anon, authenticated;

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
     or (old.token_value is not null and (
       new.token_value is distinct from old.token_value
       or new.generated_token_hash is distinct from old.generated_token_hash))
     or (old.generated_token_hash is not null and new.generated_token_hash is distinct from old.generated_token_hash)
     or not new.active then
    raise exception 'The permanent viewer link cannot be rotated or revoked.';
  end if;
  if (new.generated_token_hash is not null and new.token_value is null)
     or (new.token_value is not null and (
       length(new.token_value) < 40
       or length(new.token_value) > 100
       or encode(sha256(convert_to(new.token_value, 'UTF8')), 'hex') <> coalesce(new.generated_token_hash, new.token_hash)
     )) then
    raise exception 'The saved viewer token must match its permanent hash.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_permanent_view_link on public.org_view_links;
create trigger protect_permanent_view_link
before update or delete on public.org_view_links
for each row execute function public.protect_permanent_view_link();
update public.org_view_links set active = true where id = 1 and not active;
commit;
