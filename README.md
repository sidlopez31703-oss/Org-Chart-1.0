# Org Chart

A standalone, responsive org-chart directory with department-specific responsibility categories, connected reporting lines, print layouts, and admin editing controls.

## Secure shared mode

The website is closed until configured with Supabase. Supabase provides invite-only email sign-in, shared persistence, realtime refresh, row-level security, and a server-side sharing function that enforces a maximum of two admins.

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for setup and deployment. Configure the public Supabase URL and anon key in `supabase-config.js`; keep the service-role key on Supabase only. Apply `supabase/schema.sql`, deploy `supabase/functions/manage-sharing`, bootstrap the first admin, and then publish the static site.

The old client-side admin passcode is removed. Admin access is assigned to invited authenticated accounts, not a shared code.
