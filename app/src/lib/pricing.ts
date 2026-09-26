export { resolveStoredPlanPriceNGN, validPlanPriceNGN } from '../../../shared/plan-pricing';

export function formatNaira(amount: number): string {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}
