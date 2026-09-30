# Org Chart

A standalone, responsive org-chart directory with department-specific responsibility categories, connected reporting lines, print layouts, and admin editing controls.

## Secure shared mode

The website is closed until configured with Supabase. Supabase provides email-authenticated admins, shared persistence, realtime refresh, row-level security, a revocable bearer viewer link, and a server-side maximum of ten admins.

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for setup and deployment. Configure the public Supabase URL and anon key in `supabase-config.js`; keep the service-role key on Supabase only. Apply `supabase/schema.sql` on a fresh project or `supabase/upgrade-sharing.sql` to an existing deployment, deploy `supabase/functions/manage-sharing`, bootstrap the first admin, and then publish the static site.

The old client-side admin passcode is removed. Admin access is assigned to authenticated accounts, not a shared code. Anyone holding the viewer link can view until an admin revokes or rotates it; anyone with an admin account can edit.
