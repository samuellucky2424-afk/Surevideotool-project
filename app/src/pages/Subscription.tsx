import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Coins, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { formatNaira, resolveStoredPlanPriceNGN } from '@/lib/pricing';
import { supabase } from '@/lib/supabase';

type CreditPlan = {
  id: string;
  name: string;
  credits: number;
  priceNGN: number;
};

type SupabasePlan = {
  id: string;
  name: string | null;
  credits: number | string | null;
  usd_price: number | string | null;
  price_ngn?: number | string | null;
  created_at?: string | null;
};

function normalizePlan(plan: SupabasePlan): CreditPlan | null {
  const credits = Math.max(0, Math.floor(Number(plan.credits) || 0));
  const priceNGN = resolveStoredPlanPriceNGN(plan.usd_price, plan.price_ngn);

  if (!plan.id || credits <= 0 || priceNGN <= 0) {
    return null;
  }

  return {
    id: plan.id,
    name: plan.name?.trim() || `${credits.toLocaleString()} Credits`,
    credits,
    priceNGN,
  };
}

function formatTime(credits: number): string {
  const seconds = credits / CREDITS_PER_SECOND;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `~${minutes}m ${remainingSeconds}s`;
  }

  return `~${remainingSeconds}s`;
}

function Subscription() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [creditPlans, setCreditPlans] = useState<CreditPlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCheckingPayment, setIsCheckingPayment] = useState(false);
  const [paymentReference, setPaymentReference] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setPaymentReference(user ? sessionStorage.getItem(`paystack-reference:${user.id}`) : null);
    } catch { setPaymentReference(null); }
    setPaymentError(null);
    setPaymentMessage(null);
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;

    const fetchPlans = async (showLoading = true) => {
      if (showLoading) {
        setIsLoadingPlans(true);
      }
      setPlansError(null);

      try {
        const { data, error } = await supabase
          .from('plans')
          .select('*')
          .gt('credits', 0)
          .order('credits', { ascending: true });

        if (error) {
          throw error;
        }

        const nextPlans = ((data as SupabasePlan[]) || [])
          .map(normalizePlan)
          .filter((plan): plan is CreditPlan => plan !== null);

        if (cancelled) return;

        setCreditPlans(nextPlans);
        setSelectedPlan((current) => {
          if (!current) return null;
          return nextPlans.find((plan) => plan.id === current.id) ?? null;
        });
      } catch (error) {
        console.warn('Failed to fetch Supabase pricing plans:', error);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unable to load live pricing from Supabase.';
          setPlansError(message);
          setCreditPlans([]);
          setSelectedPlan(null);
        }
      } finally {
        if (!cancelled && showLoading) {
          setIsLoadingPlans(false);
        }
      }
    };

    void fetchPlans(true);

    const plansChannel = supabase
      .channel('surevideotool-pricing-plans')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plans' }, () => {
        void fetchPlans(false);
      })
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(plansChannel);
    };
  }, []);

  const handleSelectPlan = (plan: CreditPlan) => {
    setSelectedPlan(plan);
  };

  const rememberReference = (reference: string | null) => {
    setPaymentReference(reference);
    if (!user) return;
    try {
      if (reference) sessionStorage.setItem(`paystack-reference:${user.id}`, reference);
      else sessionStorage.removeItem(`paystack-reference:${user.id}`);
    } catch { /* Verification still works when browser storage is unavailable. */ }
  };

  const handleVerifyPayment = async (reference = paymentReference) => {
    if (!reference || isCheckingPayment) return;
    setIsCheckingPayment(true);
    setPaymentError(null);
    setPaymentMessage('Confirming your payment...');
    try {
      const response = await apiFetch('/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await response.json();
      if (response.status === 202) {
        setPaymentMessage(data.message || 'Payment is pending. Check again shortly.');
        return;
      }
      if (!response.ok || data.status !== 'success') {
        throw new Error(data.message || 'Unable to verify payment. Please try again.');
      }
      const message = data.creditsAdded > 0
        ? `${Number(data.creditsAdded).toLocaleString()} credits added. Wallet balance: ${Number(data.newCredits).toLocaleString()} credits.`
        : `Payment already processed. Wallet balance: ${Number(data.newCredits).toLocaleString()} credits.`;
      setPaymentMessage(message);
      toast.success(message);
      rememberReference(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to verify payment. Please try again.';
      setPaymentError(message);
      setPaymentMessage(null);
      toast.error(message);
    } finally {
      setIsCheckingPayment(false);
    }
  };

  const handleProceedToPayment = async () => {
    if (!selectedPlan || isProcessing || isCheckingPayment) return;
    if (!user) {
      toast.error('Please log in to purchase credits.');
      navigate('/login');
      return;
    }
    setIsProcessing(true);
    setPaymentError(null);
    setPaymentMessage('Opening secure Paystack checkout...');
    try {
      const { default: Paystack } = await import('@paystack/inline-js');
      const response = await apiFetch('/initialize-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selectedPlan.id }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await response.json();
      if (!response.ok || !data.accessCode || !data.reference) {
        throw new Error(data.message || 'Unable to open Paystack checkout.');
      }
      const reference: string = data.reference;
      rememberReference(reference);
      new Paystack().resumeTransaction(data.accessCode, {
        onLoad: () => {
          // Some transfer channels close checkout while bank confirmation is pending.
          // Keep manual verification available once the checkout has loaded.
          setIsProcessing(false);
          setPaymentMessage('Complete your payment in the Paystack window. If you have already paid, check payment status below.');
        },
        onSuccess: () => {
          setIsProcessing(false);
          void handleVerifyPayment(reference);
        },
        onCancel: () => {
          setIsProcessing(false);
          setPaymentMessage('Checkout closed. If you completed payment, use Check payment status.');
        },
        onError: (error) => {
          setIsProcessing(false);
          setPaymentMessage(null);
          setPaymentError(error.message || 'Paystack could not load. Please try again.');
        },
      });
    } catch (error) {
      setIsProcessing(false);
      setPaymentMessage(null);
      const message = error instanceof Error ? error.message : 'Unable to open Paystack checkout.';
      setPaymentError(message);
      toast.error(message);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f10] p-6 lg:p-12 flex flex-col items-center">
      <div className="w-full max-w-[800px] pb-48">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-8 text-[#a1a1aa] hover:text-white"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="mb-12">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Credits</h1>
          <p className="text-sm text-[#a1a1aa]">Select credits to power your AI transformations</p>
        </div>

        <div className="mb-6 rounded-2xl border border-[#27272a] bg-[#131316] p-5 shadow-xl shadow-black/20">
          <p className="text-sm text-white font-semibold mb-2">Need the latest version?</p>
          <p className="text-sm text-[#a1a1aa] mb-4">
            Click Recharge from the wallet page to go to Settings, then use the "Check for New Version" button to download and install updates immediately.
          </p>
          <Button
            onClick={() => navigate('/settings')}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Go to Settings
          </Button>
        </div>

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Credits</label>
          {isLoadingPlans ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">
              Loading live pricing from Supabase...
            </div>
          ) : plansError ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
              Could not load live pricing from Supabase: {plansError}
            </div>
          ) : creditPlans.length === 0 ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">
              No credit plans are configured yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {creditPlans.map((plan) => {
                const isSelected = selectedPlan?.id === plan.id;

                return (
                  <button
                    key={plan.id}
                    onClick={() => handleSelectPlan(plan)}
                    aria-pressed={isSelected}
                    disabled={isProcessing || isCheckingPayment}
                    className={`p-5 rounded-xl border text-left transition-all duration-200 ${
                      isSelected
                        ? 'bg-gradient-to-br from-blue-600/15 via-blue-600/5 to-transparent border-blue-500 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/50'
                        : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          isSelected ? 'bg-blue-500/20' : 'bg-[#27272a]'
                        }`}
                      >
                        <Coins className={`w-5 h-5 ${isSelected ? 'text-blue-400' : 'text-[#71717a]'}`} />
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#71717a]">{plan.name}</p>
                        <span className="text-lg font-bold text-white">{plan.credits.toLocaleString()} Credits</span>
                        <span className="text-xs text-[#71717a] ml-2">{formatTime(plan.credits)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-bold text-white">{formatNaira(plan.priceNGN)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">How credits work</h3>
          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- 2 credits are deducted per second of stream time</li>
            <li>- 500 credits is about 4 minutes 10 seconds</li>
            <li>- 1000 credits is about 8 minutes 20 seconds</li>
            <li>- Credits never expire</li>
          </ul>
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">Pay securely with Paystack</h3>
          <p className="text-sm text-[#a1a1aa]">
            Select a credit plan, then pay in the secure checkout window. Your credits are added automatically after payment is confirmed.
          </p>
          {user?.email && <p className="text-sm text-blue-300 mt-4">Payment email: {user.email}</p>}
          {paymentMessage && <p role="status" className="text-sm text-blue-200 mt-4">{paymentMessage}</p>}
          {paymentError && <p role="alert" className="text-sm text-red-300 mt-4">{paymentError}</p>}
          {paymentReference && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-[#a1a1aa] break-all">Payment reference: {paymentReference}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleVerifyPayment()}
                disabled={isCheckingPayment || isProcessing}
                className="min-h-11 border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
              >
                {isCheckingPayment && <Loader2 aria-hidden="true" className="w-4 h-4 mr-2 animate-spin" />}
                {isCheckingPayment ? 'Checking payment...' : 'Check payment status'}
              </Button>
            </div>
          )}
        </div>
        <p className="text-center text-sm text-[#a1a1aa] mb-4">All purchases are one-time. No subscriptions or hidden fees.</p>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 flex justify-between items-center z-50 animate-in slide-in-from-bottom shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Plan</span>
              <span className="text-xl font-bold text-white tracking-tight">
                {selectedPlan.credits.toLocaleString()} Credits <span className="text-blue-500 font-normal mx-1">/</span> {formatNaira(selectedPlan.priceNGN)}
              </span>
              <span className="text-xs text-[#71717a] mt-1">{selectedPlan.name} - {formatTime(selectedPlan.credits)} estimated time</span>
            </div>
            <Button
              onClick={handleProceedToPayment}
              disabled={isProcessing || isCheckingPayment}
              aria-busy={isProcessing || isCheckingPayment}
              className="h-12 px-6 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shrink-0"
            >
              {isProcessing || isCheckingPayment ? <Loader2 aria-hidden="true" className="w-5 h-5 animate-spin mr-2" /> : null}
              {isCheckingPayment ? 'Verifying...' : isProcessing ? 'Opening checkout...' : 'Pay with Paystack'}
              {!isProcessing && !isCheckingPayment && <ArrowRight aria-hidden="true" className="w-5 h-5 ml-2" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
