import { supabaseAdmin } from './_supabase.js';
import { createInitializeHandler } from '../shared/paystack-payment.js';

export default createInitializeHandler(supabaseAdmin);
