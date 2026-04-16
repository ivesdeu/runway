-- Brand assets: org-scoped storage RLS + private bucket, and tighten organization_public_by_slug.
-- Run after personable_crm_enhancements.sql and organizations_multitenancy.sql (requires public.user_is_org_member).

-- -----------------------------------------------------------------------------
-- 1. Private bucket (logos served via signed URLs from the app)
-- -----------------------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'brand-assets';

-- -----------------------------------------------------------------------------
-- 2. Replace legacy storage policies (public read + user_id folder only)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "brand_assets_select_public" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_update_own" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_delete_own" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_select_member" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_insert_member" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_update_member" ON storage.objects;
DROP POLICY IF EXISTS "brand_assets_delete_member" ON storage.objects;

-- First path segment: legacy uploads used auth.uid(); org-scoped uploads use organization uuid.
CREATE POLICY "brand_assets_select_member" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.user_is_org_member(((storage.foldername(name))[1])::uuid)
      )
    )
  );

CREATE POLICY "brand_assets_insert_member" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
      )
    )
  );

CREATE POLICY "brand_assets_update_member" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
      )
    )
  )
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
      )
    )
  );

CREATE POLICY "brand_assets_delete_member" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR (
        (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Slug RPC: only authenticated (client resolves slug after session exists)
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.organization_public_by_slug(text) FROM anon;
