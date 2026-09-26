import { supabaseAdmin } from './_supabase.js';
import { createVerifyHandler } from '../../shared/paystack-payment.js';

export default createVerifyHandler(supabaseAdmin);
