type PriceValue = number | string | null | undefined;

export function validPlanPriceNGN(value: PriceValue): boolean {
  const amount = Number(value);
  const kobo = amount * 100;
  return Number.isFinite(amount) && amount > 0 && amount <= 99999999.99
    && Math.abs(kobo - Math.round(kobo)) < 0.000001;
}

export function resolveStoredPlanPriceNGN(legacyPrice: PriceValue, priceNGN?: PriceValue): number {
  // Explicit NGN values never go through the old USD-size heuristic.
  if (priceNGN !== null && priceNGN !== undefined) {
    return validPlanPriceNGN(priceNGN) ? Math.round(Number(priceNGN) * 100) / 100 : 0;
  }
  // Preserve prices for rows not yet edited/migrated from the legacy schema.
  const old = Number(legacyPrice);
  if (!Number.isFinite(old) || old <= 0) return 0;
  return Math.round(old < 1000 ? old * 1150 : old);
}
