# Paystack Inline checkout

The Purchase Credits page initializes a transaction on the server and opens Paystack Inline v2 using the returned access code. Prices and credits come from the Supabase plan, and the order stores a snapshot so later price changes do not affect a payment already in progress.

## Enable payments

1. Run `supabase/paystack-payments.sql` in your Supabase SQL editor. This adds the private order table and the atomic credit function to your existing credit billing schema. Do not rerun the full schema or reset existing data.
2. Set `PAYSTACK_SECRET_KEY` in the API deployment's environment variables. Start with your Paystack test secret key; switch to the live secret key when ready. Keep the existing `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`). For local development, use `app/.env`.
3. Deploy the updated API and frontend using Node.js 22 or newer. Rebuild the desktop installer to distribute the new checkout to desktop users.
4. In Paystack Dashboard, open **Settings > API Keys & Webhooks** for the matching test/live mode and set the webhook URL to:

   ```text
   https://surevideotool-project.vercel.app/api/paystack-webhook
   ```

   This is the origin currently configured by the app. If you deploy the API on another domain, use `https://YOUR-API-DOMAIN/api/paystack-webhook` instead. The endpoint becomes available after deployment.

No frontend public key or separate webhook secret is needed in this integration. The secret stays on the server; Inline resumes the server-created transaction using its access code. Webhooks are validated using Paystack's HMAC-SHA512 signature with the same secret key.

## Endpoints

- `POST /api/initialize-payment`: Supabase bearer token and `{ "planId": "..." }`. Returns `accessCode` and `reference`.
- `POST /api/verify-payment`: Supabase bearer token and `{ "reference": "..." }`. Only the order owner can verify it. Browser-supplied credits, amounts, email and user IDs are not trusted.
- `POST /api/paystack-webhook`: accepts signed `charge.success` events without a user login. Preserves raw bytes, verifies with Paystack, checks the stored order, then applies credits.

Both confirmation paths use the same database transaction. Order locking prevents duplicate credits. Wallet changes, transaction history, subscription history and paid status either all commit or all roll back. Database/provider failures return a non-200 response so Paystack can retry.

Vercel rewrites route initialization and verification through one `payments` function. This keeps each deployment root at the Hobby limit of 12 functions. The Paystack webhook remains a separate function with raw-body parsing. Files prefixed with `_` are local handlers/helpers, not deployed endpoints.

The old provider webhook routes are retained for outstanding legacy payments. New purchases use Paystack, and `/api/verify-payment` now expects a Paystack reference. Older desktop versions using PaymentPoint should be upgraded.

## Verification

Run `npm run test:payments --prefix app` and `npm run build:app --prefix app`.

After deployment, use a signed-in account and Paystack test mode to complete a credit purchase. Verify the wallet and transaction history, then resend the same webhook from Paystack and confirm credits do not increase again. Check cancellation and the **Check payment status** button. Live payments and dashboard configuration require your own Paystack credentials.

References: [Paystack InlineJS](https://paystack.com/docs/developer-tools/inlinejs/), [webhook signatures and retries](https://paystack.com/docs/payments/webhooks/), [transaction verification](https://paystack.com/docs/payments/verify-payments/).
