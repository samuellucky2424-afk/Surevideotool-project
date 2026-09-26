# Set custom Naira plan prices

1. Run all of [the price migration](migrations/20260926213402_plan_prices_ngn.sql)
   in your project's Supabase SQL editor. Run it after the existing billing and
   admin setup; do not rerun `full_setup.sql` on the live project.
2. Deploy the updated app and payment API together. Update desktop installations
   too, since older versions still display amounts below 1,000 incorrectly.
3. In Admin > Plans, edit the desired plan, enter **100** under **Price (NGN)**,
   and save. Refresh Purchase Credits and confirm it displays **₦100**.

Prices are stored explicitly in `plans.price_ngn`. You can enter positive prices
with up to two decimal places (maximum ₦99,999,999.99, matching the existing
database price column's capacity). Paystack's own payment limits still apply.
The backend converts ₦100 to 10,000 kobo; users cannot override the saved amount
in the checkout request.

The migration preserves existing displayed prices because legacy `usd_price`
values mixed USD and NGN without a currency marker. This means an earlier saved
`100` remains at its old displayed amount until you edit it to ₦100 after the
update. No plan is automatically discounted. Pending orders keep their original
price snapshot.

For a direct SQL edit after the migration, find the correct plan UUID using the
SELECT at the end of the migration, then run (replace the UUID):

```sql
UPDATE public.plans
SET price_ngn = 100, usd_price = 100
WHERE id = 'REPLACE_WITH_PLAN_UUID'::uuid
RETURNING id, name, credits, price_ngn;
```

This updates only the selected plan; it does not change its credit quantity.
