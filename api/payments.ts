import { supabaseAdmin } from './_supabase.js';
import { createPaymentHandler } from '../shared/paystack-payment.js';

export default createPaymentHandler(supabaseAdmin);
