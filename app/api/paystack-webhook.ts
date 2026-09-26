import { supabaseAdmin } from './_supabase.js';
import { createWebhookHandler } from '../../shared/paystack-payment.js';

export const config = { api: { bodyParser: false } };
export default createWebhookHandler(supabaseAdmin);
