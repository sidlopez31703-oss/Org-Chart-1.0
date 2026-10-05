# Secure shared org chart setup

The directory supports a permanent viewer link, authenticated admin accounts, shared database saves, and a server-enforced maximum of ten administrators. It stays locked until Supabase is configured. Do not publish actual employee information until Clark County IT approves the hosting and data handling.

## What access means

- Knowing or typing the base website URL only shows a sign-in screen. Crawlers are asked not to index it, but noindex is not the security mechanism.
- Admins create a long, random viewer link in **Sharing & admins**. Anyone holding that link can view without an email account. Forwarding it forwards access too; the link has no expiration and is not replaced when copied again.
- Only authenticated admin accounts can edit directory data or manage links and accounts. Admin sign-in is by invited email and one-time link.
- Supabase row-level security protects the database. Only authenticated admins can write it. The anonymous Edge Function read path returns data only when presented a valid, active viewer-link token.
- The database trigger and server function enforce a maximum of ten admins. Admins may also invite named accounts, edit their email/role, and revoke their directory access.
- There is no shared admin code. Admin identity is tied to the authenticated email account; replacing an admin means changing roles in Share access.
- Saves are sent to the shared database, so other invited users see the same directory. Open sessions receive updates through Supabase Realtime, and the site shows save status in the top toolbar.
- Position records include vacancy status and department section labels, so both remain in the shared directory and print tree.
- Signing out clears the browser's cached directory data. Revoking membership also clears the directory from that session.

## 1. Create a Supabase project

1. Create a project at Supabase and keep its database password private.
2. In **Project Settings → API**, copy the project URL and the public anon/publishable key.
3. Put those two public values in `supabase-config.js`:

```js
window.ORG_CHART_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_PUBLIC_ANON_KEY',
  redirectUrl: 'https://YOUR_ACCOUNT.github.io/YOUR_REPOSITORY/',
};
```

The anon/publishable key is intended to be public; row-level security protects the data. Never put the `service_role` key in `index.html`, `supabase-config.js`, GitHub, or any other browser file.

## 2. Install the database protections

1. Open the Supabase **SQL Editor**.
2. Open `supabase/schema.sql` in this project, copy its contents, and run it in the SQL Editor.
3. Confirm the `org_members` and `org_state` tables exist and row-level security is enabled on both.
4. For an existing project where the original schema was already run, open `supabase/upgrade-sharing.sql`, copy its contents into a new SQL Editor query, and run it once. This adds the protected viewer-link table and raises the database admin limit to ten without deleting directory data.

The schema deliberately starts with an empty shared-state row. Browser storage is separated by site origin, so the old `file://` copy cannot be read automatically by a later GitHub Pages URL. Before changing origins, open the current local `index.html` and click **Export this browser's directory for migration** on the secure setup screen. Keep that JSON file private; it contains the directory data.

## 3. Configure invite-only email sign-in

1. In Supabase **Authentication → Providers → Email**, enable email sign-in and configure an approved email provider. The built-in sender has low rate limits.
2. Disable public sign-ups. Admins are created/invited through Supabase and subsequently managed in the website. Viewers use the permanent link and do not need accounts.
3. In **Authentication → URL Configuration**, set the Site URL to the deployed website and add its exact URL to the allowed redirect URLs. For GitHub Pages it looks like `https://YOUR_ACCOUNT.github.io/YOUR_REPOSITORY/`.
4. Test the admin sign-in link before sharing employee data.

## 4. Deploy the sharing function

The function uses Supabase's server-only service role key to send invitations and manage the access list. Supabase supplies its project URL, anon key, and service-role key to Edge Functions; do not copy the service-role key into the website.

In `supabase/config.toml`, `verify_jwt = false` is required because the function supports an anonymous viewer-link action. The function itself validates that action's high-entropy token; it still validates the signed-in user's JWT and admin role for every management action. Deploy this changed configuration and function from this project folder:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set APP_ORIGIN="https://YOUR_ACCOUNT.github.io/YOUR_REPOSITORY/"
supabase functions deploy manage-sharing
```

There is no email-domain restriction. Admins should only add trusted email accounts. The viewer link is the default way to share read-only access.

## Existing deployment: permanent viewer links

Run `supabase/permanent-view-link.sql` in Supabase SQL Editor, then deploy the updated `manage-sharing` Edge Function, then publish the website changes. The migration preserves the current token hash and re-enables that link if it was previously revoked. Previously rotated-out tokens cannot be recovered. The full token is saved only in the protected server table so admins can retrieve the same URL; it is never exposed by the anonymous read action. Existing projects must paste their current full viewer link once in Sharing & admins to enable copying it again.

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
4. Use **Sharing & admins → Get permanent viewer link**. Copy and reuse the same link whenever you share. It has no expiration and cannot be rotated or revoked. When upgrading a previously shared link, paste your current full link once when prompted; its existing token is preserved. Optional named accounts can also be invited by email, and the server rejects an eleventh admin.

## 6. Publish the static site

1. Commit `index.html`, `secure-portal.js`, `supabase-config.js`, the `supabase` folder, and this guide to the repository.
2. Enable GitHub Pages for the repository and wait for deployment.
3. Confirm the deployed URL is listed in Supabase's allowed redirect URLs and matches `APP_ORIGIN`.
4. Test the base URL (should only show sign-in), a valid viewer link (read-only), the same viewer link after getting/copying it again (still valid), and an admin account (can edit).

This version is static and does not require Node.js to serve the page. The Supabase project and Edge Function are the backend services; the browser talks to them over HTTPS.

## Security notes

- The old `0000` passcode is removed. It was visible to anyone who could inspect the HTML and was not suitable for security.
- The website link itself is not secret. Authentication plus database row-level security enforce sharing.
- The bearer viewer link is an unlisted capability, not individual identity verification: anyone who receives or is forwarded the link can view without expiration or rotation. The base URL alone grants no access.
- After a viewer opens the link once, this browser profile remembers the viewer token so reopening the base site is quick. Use **Exit shared view** on shared/public computers; reopening the original link restores viewing access.
- Removing a named account revokes its directory membership immediately; it does not delete the person's Supabase Auth identity.
- Current photo uploads are stored inside the shared JSON record. Use reasonably sized images. A production deployment with many/high-resolution employee photos should move them to private Supabase Storage with signed URLs and follow county retention/access policies.
- GitHub Pages is public hosting even when application data is protected. Have Clark County IT approve this architecture before storing personnel contact information.
