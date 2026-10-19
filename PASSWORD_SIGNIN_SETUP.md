# Public viewing and administrator password sign-in

These source changes are local until deployed. No accounts, passwords, database
policies, or live project settings were changed while preparing this update.

## What changes

- The normal website address opens the complete viewer directory without an account.
  This includes employee photos, PIDs, and contact details currently in the directory.
- Administrator sign-in uses each person's email and password. No public signup form
  or automatic administrator promotion is provided.
- Existing named roles, database row-level security, and private photo upload rules
  remain in force. Existing permanent viewer URLs still work.
- Invitation and password recovery links open a password setup screen. Ordinary
  password sign-in does not send email. Invitations and recovery still require email.
- A read-only `read-public` Edge Function action serves the directory and signed URLs
  only for photos referenced in the saved directory. It cannot write state or manage
  accounts. It is disabled unless `PUBLIC_DIRECTORY_ENABLED` equals `true`.
- Viewers refresh every five minutes. Public access does not remove bandwidth limits.

## Set the existing administrator's first password without email

This is a one-time project-owner operation using the supported Supabase Admin API.
It does not require a working email reset link. The helper only changes an existing
`org_members` administrator with an already-confirmed Auth email. It never confirms
an unverified email, creates an account, or grants a role.

1. In the Supabase project dashboard, open Authentication > Users. Confirm that your
   existing administrator account has a confirmed email. In Table Editor > org_members,
   confirm the same account's role is `admin`. Do not delete or recreate the account.
2. Open project Settings > API Keys and find the legacy `service_role` key. Reveal and
   copy it privately. It is different from the public `anon` key in supabase-config.js.
3. Open PowerShell and run:

   ```powershell
   cd 'C:\Users\lopezsi\OneDrive - Clark County NV\Desktop\Org Chart 1.0'
   & '.\tools\set-admin-password.ps1'
   ```

4. Enter your existing administrator email, paste the service_role key at the hidden
   prompt, and enter a new unique password twice. No characters appear while entering
   the key or password; that is intentional. Keep the key and password out of chat,
   screenshots, website files, and Git. Clear the copied key from your clipboard afterward.
5. The helper should report `Password updated`. If the account is unconfirmed, it stops;
   email ownership must first be verified through the invitation flow.
6. After publishing below, open the normal website and choose Administrator sign-in.

The helper was tested using mocked requests only. It has not changed any live password.
If PowerShell execution is restricted by county policy, ask IT to run the supported
Admin API operation; do not weaken the machine's policy or modify auth.users with SQL.

## Publish

From the project folder, with the Supabase CLI authenticated to the correct project:

```powershell
supabase functions deploy manage-sharing --project-ref elqgumsahrmclolbrarp
supabase secrets set PUBLIC_DIRECTORY_ENABLED=true --project-ref elqgumsahrmclolbrarp
```

The second command enables public reading of the full viewer directory. Keep existing
`APP_ORIGIN`, service keys, and database/storage policies unchanged. No SQL migration
is required. The deployed function must keep its existing `verify_jwt = false` setting;
management actions still validate the caller's token and administrator role inside it.

Review and publish the website files (index.html also contains your earlier edits):

```powershell
git diff --stat
git add index.html secure-portal.js supabase/functions/manage-sharing/index.ts tools/set-admin-password.ps1 PASSWORD_SIGNIN_SETUP.md
git commit -m "Enable public viewing and administrator password sign-in"
git pull --rebase --autostash origin main
git push origin main
```

After GitHub Pages finishes deploying:

1. Open the normal website address in a private browser window. Viewing, search,
   contact cards, printing, and photos should work without sign-in.
2. Choose Administrator sign-in and use your existing email and new password.
3. Confirm administrator tools appear, then sign out. The directory should remain
   available in viewer mode with editing tools hidden.
4. Try the old permanent viewer URL; it should also open viewer mode.

## Finish reliable invitations and recovery

Configure an approved SMTP sender in Supabase Authentication email settings. Verify
the Site URL and allowed redirect URL include the exact published website address:
`https://sidlopez31703-oss.github.io/Org-Chart-1.0/`.
Do not put SMTP credentials into website files. Keep public signups disabled.

Test a newly invited administrator accepting the invitation and choosing a password,
and an existing administrator using Set or reset password. Email limits and email
security scanners can still affect these one-time messages until delivery is fixed.
Every administrator should use an individual account. Revoking named access now
removes account privileges; the person can still view the publicly available directory.

## Validation completed locally

- Public viewing; password login failure/success; sign-out returns to viewing.
- Invitation/recovery password setup and mismatched-password rejection.
- Expired email errors and email rate-limit feedback.
- Read-only endpoint disabled by default; anonymous and viewer account management denied.
- Password helper changes only one verified existing administrator (mocked API tests).

These checks use browser/API mocks, not a live Supabase deployment audit. Live invitation
delivery, actual passwords, and deployed row-level security still require the checks above.
