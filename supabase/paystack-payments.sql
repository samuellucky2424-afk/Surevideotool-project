-- Run once in the Supabase SQL editor before deploying the Paystack checkout.
-- Uses the credit billing tables from full_setup.sql / schema.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS public.paystack_orders (
  reference TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id),
  email TEXT NOT NULL,
  plan_id UUID NOT NULL,
  plan_name TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
ALTER TABLE public.paystack_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paystack_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.paystack_orders TO service_role;

CREATE OR REPLACE FUNCTION public.apply_paystack_payment(
  p_reference TEXT, p_amount_kobo BIGINT, p_currency TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order public.paystack_orders%ROWTYPE;
  v_balance INTEGER;
BEGIN
  SELECT * INTO v_order FROM public.paystack_orders
    WHERE reference = p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown Paystack order'; END IF;
  IF p_amount_kobo IS DISTINCT FROM v_order.amount_kobo
      OR p_currency IS DISTINCT FROM v_order.currency THEN
    RAISE EXCEPTION 'Payment amount or currency mismatch';
  END IF;
  IF v_order.status = 'success' THEN
    SELECT credits INTO v_balance FROM public.wallets WHERE user_id = v_order.user_id;
    RETURN jsonb_build_object('status', 'success', 'reference', p_reference,
      'message', 'Payment already processed', 'creditsAdded', 0, 'newCredits', COALESCE(v_balance, 0));
  END IF;

  INSERT INTO public.wallets (user_id, credits) VALUES (v_order.user_id, v_order.credits)
    ON CONFLICT (user_id) DO UPDATE SET credits = COALESCE(wallets.credits, 0) + EXCLUDED.credits
    RETURNING credits INTO v_balance;

  -- Support both transaction column layouts shipped in this repository.
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'amount_naira') THEN
    INSERT INTO public.transactions (user_id, type, amount_naira, credits, reference, description)
      VALUES (v_order.user_id, 'credit_purchase', v_order.amount_kobo / 100.0,
        v_order.credits, p_reference, 'Paystack: ' || v_order.plan_name);
  ELSE
    INSERT INTO public.transactions (user_id, type, amount, credits, reference, description, status)
      VALUES (v_order.user_id, 'credit', v_order.amount_kobo / 100.0,
        v_order.credits, p_reference, 'Paystack: ' || v_order.plan_name, 'success');
  END IF;
  INSERT INTO public.subscriptions (user_id, plan_name, amount_paid, credits, status)
    VALUES (v_order.user_id, v_order.plan_name, v_order.amount_kobo / 100.0, v_order.credits, 'active');
  UPDATE public.paystack_orders SET status = 'success', paid_at = NOW() WHERE reference = p_reference;
  RETURN jsonb_build_object('status', 'success', 'reference', p_reference,
    'message', 'Payment verified', 'creditsAdded', v_order.credits, 'newCredits', v_balance);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_paystack_payment(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_paystack_payment(TEXT, BIGINT, TEXT) TO service_role;
COMMIT;
