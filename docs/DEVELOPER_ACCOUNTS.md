## Developer allowlist

Internal org provisioning is gated by an email allowlist stored in `public.developer_accounts`.

### Add a developer

Run in Supabase SQL editor (service role / dashboard SQL):

```sql
insert into public.developer_accounts (email)
values ('you@company.com')
on conflict (email) do nothing;
```

### Remove a developer

```sql
delete from public.developer_accounts
where email = lower(trim('you@company.com'));
```

