# Org Chart

A standalone, responsive org-chart directory with department-specific responsibility categories, connected reporting lines, print layouts, and admin editing controls.

Position administration supports filled and vacant roles. Vacant positions keep their full title and hierarchy/PID without requiring employee contact details. Department managers can add section labels (for example, “Inspection Area 5”) and place positions or nested labels underneath them.

## Secure shared mode

The website is closed until configured with Supabase. Supabase provides email-authenticated admins, shared persistence, realtime refresh, row-level security, a permanent bearer viewer link, and a server-side maximum of ten admins.

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for setup and deployment. Configure the public Supabase URL and anon key in `supabase-config.js`; keep the service-role key on Supabase only. Apply `supabase/schema.sql` on a fresh project or `supabase/upgrade-sharing.sql` to an existing deployment, deploy `supabase/functions/manage-sharing`, bootstrap the first admin, and then publish the static site.

The old client-side admin passcode is removed. Admin access is assigned to authenticated accounts, not a shared code. Anyone holding the viewer link can view without link expiration or rotation; anyone with an admin account can edit.
