-- Demo workspace + attribution_leads rows for Runway MVP "View Demo" (leads loaded via Edge Function).
-- ADDITIVE ONLY. Idempotent via fixed UUIDs.

INSERT INTO public.organizations (id, slug, name)
VALUES (
  '00000000-0000-4000-b000-000000000001',
  'runway-demo',
  'Runway Demo Workspace'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.attribution_leads (
  id,
  organization_id,
  submitted_at,
  company_name,
  search_keyword,
  utm_campaign,
  ga_client_id,
  purchased,
  purchase_amount,
  import_source,
  raw_import
)
VALUES
  (
    'b1000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-b000-000000000001',
    '2026-01-08',
    'Aurora Analytics',
    'b2b analytics consulting',
    'SaaS & analytics — Search (Aurora, Juniper)',
    '2918473821.1749283019',
    true,
    42000,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-b000-000000000001',
    '2026-02-14',
    'Juniper Learning',
    'edtech marketing agency',
    'SaaS & analytics — Search (Aurora, Juniper)',
    '3019283746.1827364510',
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-b000-000000000001',
    '2026-01-22',
    'Brightline Health',
    'patient acquisition campaigns',
    'Healthcare — Patient growth (Brightline)',
    '2847362910.1638472910',
    true,
    51800,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-b000-000000000001',
    '2026-02-03',
    'Copper Kettle Co.',
    'restaurant loyalty program ads',
    'Retail & farms — Performance Max (Copper, Evergreen, Greenleaf)',
    '2736482910.1928374650',
    true,
    19200,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-b000-000000000001',
    '2026-03-01',
    'Evergreen Supply',
    'retail inventory forecasting software',
    'Retail & farms — Performance Max (Copper, Evergreen, Greenleaf)',
    '2658392017.1748392017',
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-b000-000000000001',
    '2026-03-18',
    'Greenleaf Farms',
    'ag wholesale digital marketing',
    'Retail & farms — Performance Max (Copper, Evergreen, Greenleaf)',
    '2583746192.1837461928',
    true,
    11800,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000007',
    '00000000-0000-4000-b000-000000000001',
    '2026-02-27',
    'Harborlight Capital',
    'institutional lp reporting tools',
    'Finance — SEO & trust content (Harborlight)',
    '2473829103.1928374655',
    true,
    24600,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000008',
    '00000000-0000-4000-b000-000000000001',
    '2026-01-30',
    'Driftwood Studio',
    'brand design agency portfolio',
    'Design & media — Social (Driftwood, Inkwell)',
    '2391827364.1748392012',
    true,
    33500,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-000000000009',
    '00000000-0000-4000-b000-000000000001',
    '2026-04-02',
    'Inkwell Publishing',
    'book launch paid social',
    'Design & media — Social (Driftwood, Inkwell)',
    '2319283746.1658392014',
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-b000-000000000001',
    '2026-03-09',
    'Falcon Mobility',
    'fleet telematics advertising',
    'Mobility & built env — LinkedIn ABM (Falcon, Kindred, Lumen)',
    '2238472910.1928374601',
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-00000000000b',
    '00000000-0000-4000-b000-000000000001',
    '2026-03-25',
    'Kindred Robotics',
    'industrial automation leads',
    'Mobility & built env — LinkedIn ABM (Falcon, Kindred, Lumen)',
    '2158392736.1837461922',
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-00000000000c',
    '00000000-0000-4000-b000-000000000001',
    '2026-02-11',
    'Lumen Architecture',
    'architecture firm lead generation',
    'Mobility & built env — LinkedIn ABM (Falcon, Kindred, Lumen)',
    '2073829183.1748392008',
    true,
    68900,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  ),
  (
    'b1000000-0000-4000-8000-00000000000d',
    '00000000-0000-4000-b000-000000000001',
    '2026-04-10',
    'Summit Finance',
    'fractional cfo marketing',
    NULL,
    NULL,
    false,
    0,
    'dashboard',
    '{"mvp_demo":true}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
