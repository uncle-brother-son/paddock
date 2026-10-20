-- 010_store_credit.sql
-- ALREADY APPLIED to the live Supabase project (migration "store_credit_ledger"); recorded here so repo history matches.
-- Do not run again.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS store_credit_balance numeric(10,2) NOT NULL DEFAULT 0
  CONSTRAINT customers_store_credit_balance_nonneg CHECK (store_credit_balance >= 0);

CREATE TABLE IF NOT EXISTS public.store_credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount numeric(10,2) NOT NULL CHECK (amount <> 0),
  balance_after numeric(10,2) NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL CHECK (reason IN ('refund','manual_adjustment','redemption','redemption_reversal','migrated_from_gift_card')),
  order_id uuid REFERENCES public.orders(id),
  booking_id uuid REFERENCES public.bookings(id),
  gift_card_id uuid REFERENCES public.gift_cards(id),
  staff_id uuid REFERENCES public.staff(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_credit_transactions_customer_idx ON public.store_credit_transactions (customer_id, created_at DESC);
ALTER TABLE public.store_credit_transactions ENABLE ROW LEVEL SECURITY;

-- Adds (positive) or removes (negative) store credit atomically; the row lock serialises concurrent changes
-- and the balance can never go below zero.
CREATE OR REPLACE FUNCTION public.store_credit_apply(
  p_customer_id uuid, p_amount numeric, p_reason text,
  p_order_id uuid DEFAULT NULL, p_booking_id uuid DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL, p_note text DEFAULT NULL, p_gift_card_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance numeric; v_new numeric; v_txn uuid;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_required');
  END IF;
  SELECT store_credit_balance INTO v_balance FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'customer_not_found');
  END IF;
  v_new := round(v_balance + p_amount, 2);
  IF v_new < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_store_credit', 'balance', v_balance);
  END IF;
  UPDATE customers SET store_credit_balance = v_new, updated_at = now() WHERE id = p_customer_id;
  INSERT INTO store_credit_transactions (customer_id, amount, balance_after, reason, order_id, booking_id, gift_card_id, staff_id, note)
  VALUES (p_customer_id, round(p_amount,2), v_new, p_reason, p_order_id, p_booking_id, p_gift_card_id, p_staff_id, p_note)
  RETURNING id INTO v_txn;
  RETURN jsonb_build_object('ok', true, 'transaction_id', v_txn, 'balance', v_new);
END $$;

REVOKE EXECUTE ON FUNCTION public.store_credit_apply(uuid,numeric,text,uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_credit_apply(uuid,numeric,text,uuid,uuid,uuid,text,uuid) TO service_role;

-- One-off data move: credit-style gift cards (issued by refunds) became customer balance; cards voided.
DO $$
DECLARE r record; res jsonb;
BEGIN
  FOR r IN SELECT id, purchaser_id, remaining_balance FROM gift_cards
           WHERE origin = 'issued_as_credit' AND voided IS NOT TRUE AND remaining_balance > 0 AND purchaser_id IS NOT NULL
  LOOP
    res := public.store_credit_apply(r.purchaser_id, r.remaining_balance, 'migrated_from_gift_card', NULL, NULL, NULL, 'Migrated from credit-style gift card', r.id);
    IF (res->>'ok')::boolean THEN
      UPDATE gift_cards SET remaining_balance = 0, voided = true, updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
