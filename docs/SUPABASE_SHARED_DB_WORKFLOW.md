## Supabase shared DB workflow (Compass + Runway)

This repo shares a hosted Supabase project with other apps (e.g. Compass). **Never “reset”** anything on the hosted DB.

### Key idea
- Treat `public.organizations` as the **canonical shared org table** (IDs line up across apps).
- Gate per-app access via **org entitlements** in `public.organization_apps` (e.g. `compass`, `runway`).
- Keep a **single Supabase Auth project** so passwords are automatically unified across apps.

### Prerequisites
- Supabase CLI installed and logged in
- Repo linked to the correct project ref:

```bash
supabase link --project-ref ausivxesedagohjlthiy
```

### Docker requirement for `db pull`
`supabase db pull` creates a **shadow database container** to diff schemas. It requires:
- Docker Desktop installed
- Docker engine running

If Docker isn’t available, you can still use `supabase db push` and `supabase functions deploy`, but `db pull` will fail.

### Safe sequence (shared hosted DB)

1) Sync migration files from the hosted project

```bash
supabase migrations fetch --linked
```

If prompted to overwrite, choose **Yes**. The goal is to make your local `supabase/migrations/` match the remote migration ledger.

2) Optional: pull a snapshot migration of the remote schema (requires Docker)

```bash
supabase db pull
```

This writes a new `*_remote_schema.sql` file in `supabase/migrations/`. **Do not edit** that file. It’s a snapshot to help diffs.

3) Add your own new migration(s)
- Create a new `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
- Keep it **additive** (use `IF NOT EXISTS`, avoid drops/renames unless intentional)

4) Apply migrations to hosted DB

```bash
supabase db push
```

5) Deploy edge functions (no Docker required)

```bash
supabase functions deploy dev-admin
```

### When you see “migration history does not match”
This means the hosted DB has migration versions recorded that your local folder doesn’t have.

Fix:
1) `supabase migrations fetch --linked`
2) Retry `supabase db push`

Avoid using `supabase migration repair` unless you know exactly why. It only edits the migration ledger table, but on a shared DB you should prefer fetching first.

