-- Run before deploying manage-sharing and publishing the photo-storage update.
begin;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-photos', 'org-photos', false, 524288, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Named members may read private photos; only administrators may insert.
-- No browser update/delete policy: files use unique names and never overwrite.
drop policy if exists "org members read photos" on storage.objects;
create policy "org members read photos" on storage.objects
for select to authenticated
using (bucket_id = 'org-photos' and public.is_org_member());
drop policy if exists "org admins upload photos" on storage.objects;
create policy "org admins upload photos" on storage.objects
for insert to authenticated
with check (bucket_id = 'org-photos' and public.is_org_admin()
  and name ~ '^photos/[a-f0-9-]+\.(webp|jpg|png)$');
commit;
