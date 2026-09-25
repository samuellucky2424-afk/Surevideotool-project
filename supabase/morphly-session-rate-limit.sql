-- Run once in the Supabase SQL editor before deploying the Morphly integration.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS morphly_expires_at timestamptz;
CREATE TABLE IF NOT EXISTS public.realtime_start_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_attempt timestamptz NOT NULL
);
ALTER TABLE public.realtime_start_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.realtime_start_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_realtime_start(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed uuid;
BEGIN
  INSERT INTO realtime_start_limits(user_id, last_attempt) VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE SET last_attempt = now()
    WHERE realtime_start_limits.last_attempt < now() - interval '30 seconds'
  RETURNING user_id INTO claimed;
  RETURN claimed IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_realtime_start(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_realtime_start(uuid) TO service_role;
