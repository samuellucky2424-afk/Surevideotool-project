// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './_supabase.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabaseAdmin) {
    return res.status(200).json({
      balance: 0,
      credits: 0,
      transactions: [],
      warning: supabaseAdminConfigError || 'Supabase admin is not configured'
    });
  }
  
  const userId = req.query.userId || req.query.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from('wallets')
      .select('credits')
      .eq('user_id', userId)
      .maybeSingle();

    if (walletErr) {
      console.error('[api/wallet] supabase wallets query failed:', walletErr);
      return res.status(500).json({ error: walletErr.message || 'wallet query failed' });
    }

    let txs: any[] = [];
    {
      const r = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (r.error) {
        console.warn('[api/wallet] transactions query failed (continuing with empty list):', r.error);
      } else {
        txs = r.data || [];
      }
    }

    // Map DB columns to our frontend transaction structure
    const mappedTxs = txs.map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      credits: tx.credits || 0,
      description: tx.description || (tx.type === 'credit' ? 'Credits purchased' : 'Session usage'),
      timestamp: tx.created_at,
    }));

    return res.json({
      balance: 0,
      credits: wallet?.credits ?? 0,
      transactions: mappedTxs,
    });
  } catch (error) {
    console.error('[api/wallet] unexpected error:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}
