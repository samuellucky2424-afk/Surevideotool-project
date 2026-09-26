-- Run in the Supabase SQL editor after the existing billing/admin setup.
-- Deploy the updated app after running this migration. Safe to rerun.
BEGIN;

ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS price_ngn NUMERIC
  CHECK (price_ngn > 0 AND price_ngn <= 99999999.99 AND price_ngn = ROUND(price_ngn, 2));

-- Preserve amounts previously displayed by the app; never re-convert an explicit NGN price.
UPDATE public.plans
SET price_ngn = ROUND(CASE WHEN usd_price < 1000 THEN usd_price * 1150 ELSE usd_price END)
WHERE price_ngn IS NULL AND usd_price > 0 AND usd_price <= 99999999.99;

-- Keep the privileged implementation outside the exposed public API schema.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE OR REPLACE FUNCTION private.admin_upsert_plan_ngn(
  p_id UUID, p_name TEXT, p_credits INTEGER, p_price_ngn NUMERIC
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_admin UUID := auth.uid();
  v_id UUID;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_name IS NULL OR LENGTH(TRIM(p_name)) = 0 THEN
    RAISE EXCEPTION 'Name required';
  END IF;
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RAISE EXCEPTION 'Credits must be a positive whole number';
  END IF;
  IF p_price_ngn IS NULL OR p_price_ngn <= 0 OR p_price_ngn > 99999999.99
      OR p_price_ngn <> ROUND(p_price_ngn, 2) THEN
    RAISE EXCEPTION 'Price must be between NGN 0.01 and 99999999.99, with at most two decimal places';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.plans (name, credits, usd_price, price_ngn)
    VALUES (TRIM(p_name), p_credits, p_price_ngn, p_price_ngn)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.plans
    SET name = TRIM(p_name), credits = p_credits, usd_price = p_price_ngn, price_ngn = p_price_ngn
    WHERE id = p_id RETURNING id INTO v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
  END IF;
  INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
  VALUES (v_admin, 'upsert_plan', 'plans', v_id::TEXT,
    json_build_object('name', TRIM(p_name), 'credits', p_credits, 'price_ngn', p_price_ngn, 'currency', 'NGN'));
  RETURN json_build_object('success', TRUE, 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION private.admin_upsert_plan_ngn(UUID, TEXT, INTEGER, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.admin_upsert_plan_ngn(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_upsert_plan_ngn(
  p_id UUID, p_name TEXT, p_credits INTEGER, p_price_ngn NUMERIC
) RETURNS JSON LANGUAGE sql SECURITY INVOKER SET search_path = public
AS $$
  SELECT private.admin_upsert_plan_ngn(p_id, p_name, p_credits, p_price_ngn);
$$;
REVOKE ALL ON FUNCTION public.admin_upsert_plan_ngn(UUID, TEXT, INTEGER, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_plan_ngn(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;

-- Old admin clients already submit NGN using a misleading parameter name.
-- Route those edits through the same validation and explicit currency storage.
CREATE OR REPLACE FUNCTION public.admin_upsert_plan(
  p_id UUID, p_name TEXT, p_credits INTEGER, p_usd_price NUMERIC
) RETURNS JSON LANGUAGE sql SECURITY INVOKER SET search_path = public
AS $$
  SELECT public.admin_upsert_plan_ngn(p_id, p_name, p_credits, p_usd_price);
$$;
REVOKE ALL ON FUNCTION public.admin_upsert_plan(UUID, TEXT, INTEGER, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_plan(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;

COMMIT;

-- Review amounts after migration. In the updated admin dashboard, edit and save
-- the intended plan as 100 to charge NGN 100. Existing prices are preserved above.
SELECT id, name, credits, price_ngn FROM public.plans ORDER BY credits;
