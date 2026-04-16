# Org slug URLs and static hosting

The dashboard expects URLs like `https://your-host/your-org-slug/` so the first path segment resolves to a workspace. Deep links must load `index.html` and let the client read the path.

## Netlify

`public/_redirects` is copied into the site root by the static build. It contains:

```text
/*    /index.html   200
```

Netlify serves real files (e.g. `/assets/...`) when they exist, then falls back to `index.html` for unknown paths.

## Vercel

Add a `vercel.json` rewrite if you deploy there instead of Netlify, for example:

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Refine this if you need to exclude API routes or static assets (often unnecessary when assets live under paths that exist as files).

## Supabase Auth redirect URLs

- OAuth uses `redirectTo = origin + pathname + search` so query strings such as `?invite=…` survive the round trip (GitHub and other providers).
- Returning to `https://app.example.com/acme/` (with or without a trailing path) is normal.
- In the Supabase dashboard, add your production and preview **Site URL** and **Redirect URLs** for each origin you use (e.g. `http://localhost:5173`, `https://your-domain.com`). Wildcards for arbitrary slugs are often unnecessary if the callback stays on the same origin; confirm against [Supabase redirect URL docs](https://supabase.com/docs/guides/auth/redirect-urls).

## SQL migration order

Run existing bootstrap/sync scripts first, then apply `supabase/organizations_multitenancy.sql` in the SQL editor. If the auth trigger fails on `EXECUTE PROCEDURE`, try `EXECUTE FUNCTION` for your Postgres version.

After multitenancy (and `personable_crm_enhancements.sql` if you use CRM logos), run [`supabase/brand_assets_org_rls.sql`](supabase/brand_assets_org_rls.sql) so the `brand-assets` bucket is private, storage paths are org-scoped, and `organization_public_by_slug` is not callable as `anon`.

Then run [`supabase/organization_members_manage.sql`](supabase/organization_members_manage.sql) for **Your team**: `organization_members` UPDATE/DELETE RLS, owner safeguards (triggers), and the `organization_invitations` table.

Then run [`supabase/workspace_onboarding_and_create.sql`](supabase/workspace_onboarding_and_create.sql) for **first-time workspace setup** and **creating extra workspaces**: adds `organizations.onboarding_completed`, replaces `handle_new_user_org` so new signups start with `onboarding_completed = false`, and creates RPCs `update_workspace_profile` and `create_workspace_for_user` used by the dashboard.

## First-time users and onboarding

1. **Default org**: After `organizations_multitenancy.sql` + `workspace_onboarding_and_create.sql`, each new `auth.users` row gets an organization via `handle_new_user_org` with `onboarding_completed = false` until the user completes the in-app **Name your workspace** step (company name, URL slug, optional branding).
2. **Existing orgs**: The migration adds `onboarding_completed` with default `true` so current customers are not prompted again.
3. **Invites**: Invite links use `?invite=TOKEN`. The client copies the token to `sessionStorage` if the user is not signed in yet, and GitHub OAuth preserves the query string on return. After sign-in, `accept-org-invite` runs, then the browser is sent to `/{slug}/`.
4. **Multiple workspaces**: Signed-in users can open **Workspaces** in the sidebar, switch orgs, or create another org (RPC `create_workspace_for_user`).

### `APP_BASE_URL`

Used when creating invite links (`organization-team` `invite` action). Should match your deployed site origin (no trailing slash), e.g. `https://your-app.netlify.app`. Defaults to `http://localhost:5173` if unset.

### Team roles (UI vs database)

The UI labels **`member`** as **Employee**. Database roles remain `owner`, `admin`, `member`, `viewer`. Only **Owner** can assign the **Owner** role; **Admins** manage Admin / Employee / Viewer for others.

### Invitations

**Create invite link** stores a row in `organization_invitations` and returns a URL like `{APP_BASE_URL}/?invite=TOKEN`. The invitee should use the **same email** as the invite. If they open the link before signing in, the token is stored in `sessionStorage` and a short hint appears on the login screen; after password or GitHub sign-in, [`public/assets/supabase-auth.js`](public/assets/supabase-auth.js) calls `accept-org-invite`, then redirects to `/{slug}/`. If acceptance fails (wrong email, expired invite), the session stays signed in when possible and a banner message explains the error. There is no separate email provider in-repo; copy the link into your own email or add Resend/etc. later.

## Edge Function secrets

### `DASHBOARD_ALLOWED_ORIGINS`

Browser calls to Edge Functions (`ai-assistant`, `create-stripe-checkout-session`, `organization-team`, `accept-org-invite`) use CORS allowlists. Set this secret to a comma-separated list of exact origins, for example:

`https://your-app.netlify.app,https://your-domain.com`

Local dev defaults include `http://localhost:5173` and `http://127.0.0.1:5173`. Without a production origin in the list, browsers will block cross-origin requests from your deployed dashboard.

### Stripe webhooks and `organization_id`

The `stripe-webhook` function **requires** `metadata.organization_id` on `checkout.session.completed` and `checkout.session.expired`, and checks that it matches the invoice row. Checkout sessions created by the current `create-stripe-checkout-session` function include this metadata. **Legacy** Checkout sessions that lack `organization_id` will no longer update invoices until customers complete payment using a new session (or you fix metadata in Stripe manually).

## Redeploy Edge Functions

After changing function code or secrets, deploy from the repo root, for example:

`supabase functions deploy ai-assistant create-stripe-checkout-session stripe-webhook organization-team accept-org-invite --project-ref <your-project-ref>`
