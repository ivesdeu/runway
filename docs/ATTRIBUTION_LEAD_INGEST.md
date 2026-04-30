# Attribution lead ingest (forms & GTM)

Edge Function: `attribution-lead-ingest`

## Authentication (pick one)

1. **Public site / GTM (no user session)**  
   - Set Supabase secret: `ATTRIBUTION_INGEST_SECRET` (long random string).  
   - Send the same value as header `x-attribution-ingest-secret: <secret>` **or** JSON field `ingestSecret` (header preferred).

2. **Signed-in dashboard user**  
   - `Authorization: Bearer <supabase_access_token>`  
   - User must be a member of `organizationId`.

## Endpoint

`POST https://<project>.supabase.co/functions/v1/attribution-lead-ingest`

`Content-Type: application/json`

## Body fields

| Field | Required | Notes |
|--------|-----------|--------|
| `organizationId` | yes | UUID of the workspace org |
| `email` | recommended | Lowercased on save |
| `contactName` / `companyName` / `phone` | optional | |
| `utmSource`, `utmMedium`, `utmCampaign` | optional | Align `utmCampaign` with GA4 session campaign |
| `gaClientId`, `gaSessionId`, `userPseudoId` | optional | From gtag / dataLayer |
| `gclid`, `searchKeyword` | optional | When available from Ads / landing |
| `marketingClientId` | optional | Stable ID from your form (ties to CRM match rules) |
| `submittedAt` | optional | ISO 8601; default now |
| `firstTouch` | optional | JSON object snapshot |
| `importSource` | optional | Default `form` |

## Example (fetch from your site)

```json
{
  "organizationId": "00000000-0000-0000-0000-000000000000",
  "email": "lead@example.com",
  "utmCampaign": "spring_search",
  "utmSource": "google",
  "utmMedium": "cpc",
  "marketingClientId": "cid_abc123",
  "gaClientId": "..."
}
```

## Bulk CSV / CRM import

Use `attribution-leads-import-bulk` with a logged-in user JWT (max 500 rows per request). See function source for per-row field names (same camelCase or snake_case aliases).
