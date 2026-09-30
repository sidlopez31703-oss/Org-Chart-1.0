# Secure shared org chart setup

The directory now supports invite-only email sign-in, shared database saves, viewer/admin roles, and a server-enforced maximum of two administrators. It stays locked until Supabase is configured. Do not publish actual employee information until Clark County IT approves the hosting and data handling.

## What access means

- Knowing or typing the website URL only shows a sign-in screen.
- Public account creation is disabled. An administrator shares an email address first.
- An invited person follows the Supabase invitation link, then signs in with that same email using a one-time link.
- Supabase row-level security allows shared users to read the directory. Only admins can write it.
- Admins can share/remove access and change a person's role. The database trigger and server function enforce a maximum of two admins.
- There is no shared admin code. Admin identity is tied to the authenticated email account; replacing an admin means changing roles in Share access.
- Saves are sent to the shared database, so other invited users see the same directory. Open sessions receive updates through Supabase Realtime, and the site shows save status in the top toolbar.
- Signing out clears the browser's cached directory data. Revoking membership also clears the directory from that session.

## 1. Create a Supabase project

1. Create a project at Supabase and keep its database password private.
2. In **Project Settings → API**, copy the project URL and the public anon/publishable key.
3. Put those two public values in `supabase-config.js`:

```js
window.ORG_CHART_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_PUBLIC_ANON_KEY',
};
```

The anon/publishable key is intended to be public; row-level security protects the data. Never put the `service_role` key in `index.html`, `supabase-config.js`, GitHub, or any other browser file.

## 2. Install the database protections

1. Open the Supabase **SQL Editor**.
2. Open `supabase/schema.sql` in this project, copy its contents, and run it in the SQL Editor.
3. Confirm the `org_members` and `org_state` tables exist and row-level security is enabled on both.

The schema deliberately starts with an empty shared-state row. Browser storage is separated by site origin, so the old `file://` copy cannot be read automatically by a later GitHub Pages URL. Before changing origins, open the current local `index.html` and click **Export this browser's directory for migration** on the secure setup screen. Keep that JSON file private; it contains the directory data.

## 3. Configure invite-only email sign-in

1. In Supabase **Authentication → Providers → Email**, enable email sign-in and configure the email templates/provider required by your organization.
2. Disable public sign-ups. Administrators use Supabase's invitation API; users cannot self-register into the directory.
3. In **Authentication → URL Configuration**, set the Site URL to the deployed website and add its exact URL to the allowed redirect URLs. For GitHub Pages it looks like `https://YOUR_ACCOUNT.github.io/YOUR_REPOSITORY/`.
4. Test invitation and one-time sign-in links from a non-admin test account before sharing employee data.

## 4. Deploy the sharing function

The function uses Supabase's server-only service role key to send invitations and manage the access list. Supabase supplies its project URL, anon key, and service-role key to Edge Functions; do not copy the service-role key into the website.

Install the Supabase CLI from the official Supabase CLI releases, then run in this project folder:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set APP_ORIGIN="https://YOUR_ACCOUNT.github.io/YOUR_REPOSITORY/"
supabase functions deploy manage-sharing
```

If Clark County IT confirms a single approved email domain, set it as an additional server-side restriction:

```powershell
supabase secrets set ALLOWED_EMAIL_DOMAIN="approved-domain.gov"
```

Do not guess the county's official email domain. If this secret is not set, the app still permits only addresses explicitly invited by an admin.

## 5. Bootstrap the first administrator

This is a one-time manual step so no public user can claim the first admin role:

1. In Supabase **Authentication → Users**, invite the first admin's email address.
2. In **SQL Editor**, run the following after replacing the email with that exact address:

```sql
insert into public.org_members (user_id, email, role)
select id, lower(email), 'admin'
from auth.users
where lower(email) = lower('first.admin@approved-domain.gov')
on conflict (user_id) do update set role = 'admin', email = excluded.email;
```

3. Open the deployed site, enter the first admin email, and request the sign-in link. Follow the email link in the same browser. If the shared database is empty, an admin-only initialization screen appears. Choose the migration JSON file and click **Import and initialize**, or click **Initialize current directory** to use the current browser data. Nothing is uploaded until an admin explicitly chooses one of these actions.
4. Use **Share access** to invite the second admin and viewers. The server rejects a third admin.

## 6. Publish the static site

1. Commit `index.html`, `secure-portal.js`, `supabase-config.js`, the `supabase` folder, and this guide to the repository.
2. Enable GitHub Pages for the repository and wait for deployment.
3. Confirm the deployed URL is listed in Supabase's allowed redirect URLs and matches `APP_ORIGIN`.
4. Test with an invited viewer, an invited admin, and an uninvited email. The uninvited account must not load directory data.

This version is static and does not require Node.js to serve the page. The Supabase project and Edge Function are the backend services; the browser talks to them over HTTPS.

## Security notes

- The old `0000` passcode is removed. It was visible to anyone who could inspect the HTML and was not suitable for security.
- The website link itself is not secret. Authentication plus database row-level security enforce sharing.
- Admins can grant access only through **Share access**. Removing an email revokes its database membership immediately, even if the person still has an old sign-in link.
- Current photo uploads are stored inside the shared JSON record. Use reasonably sized images. A production deployment with many/high-resolution employee photos should move them to private Supabase Storage with signed URLs and follow county retention/access policies.
- GitHub Pages is public hosting even when application data is protected. Have Clark County IT approve this architecture before storing personnel contact information.
