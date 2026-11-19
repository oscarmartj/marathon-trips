// The GST arithmetic for receipts (plan docs/plans/4.6-reconciliation-receipts.md, section 4.2 and review R6, R7). NOT
// wired to the issuing of documents: GST registration cannot be switched on in 4.6 until Oscar's accountant validates
// the model, so every receipt is issued without GST. Not tax advice.
//
// THE rounding rule, stated once (plan 0.1, 1.1): integer arithmetic, to the minor unit, half up on the absolute value.
// This is the only file of the payments module that divides an amount for GST.
//
// Declared deviation from plan 0.1, 1.1 ("GST per component, split by largest remainder"): a package is treated as a
// whole by the country of its race (overseas services booked in Australia are GST-free: ATO, "GST and international
// travel"); the treatment and the registration are frozen on a booking's first document when this gets wired.

export type GstTreatment = 'taxable' | 'not_taxable' | 'unknown';

/** `a × num / den`, rounded half up on the absolute value. `den` > 0, `num` ≥ 0. */
export function mulDivHalfUpAny(a: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n || num < 0n) throw new RangeError('mulDivHalfUpAny: den must be positive and num not negative');
  const abs = a < 0n ? -a : a;
  const q = (abs * num * 2n + den) / (den * 2n);
  return a < 0n ? -q : q;
}

/** The treatment of a whole package by its race's country: Australia taxable, elsewhere not; unknown without a country. */
export function gstTreatment(raceCountry: string | null | undefined): GstTreatment {
  if (!raceCountry || !/^[A-Z]{2}$/.test(raceCountry)) return 'unknown';
  return raceCountry === 'AU' ? 'taxable' : 'not_taxable';
}

/** GST included in a GST-inclusive total: 1/11 of it, by the rounding rule. 0 when not taxable. */
export function bookingGst(totalMinor: bigint, treatment: GstTreatment): bigint {
  if (treatment === 'unknown') throw new RangeError('bookingGst: unknown treatment');
  if (treatment === 'not_taxable' || totalMinor <= 0n) return 0n;
  return mulDivHalfUpAny(totalMinor, 1n, 11n);
}

/**
 * GST accumulated on a booking once `fundsMinor` of its total is applied (customer_funds after a posting, review R6):
 * the booking's GST in proportion, by the rounding rule. Overpayments are not part of it (they are held to be returned).
 */
export function cumulativeGst(bookingGstMinor: bigint, totalMinor: bigint, fundsMinor: bigint): bigint {
  if (totalMinor <= 0n || bookingGstMinor <= 0n) return 0n;
  const applied = fundsMinor < 0n ? 0n : fundsMinor > totalMinor ? totalMinor : fundsMinor;
  return mulDivHalfUpAny(bookingGstMinor, applied, totalMinor);
}

/**
 * The GST of one document: what the booking's GST accumulated to after its posting, less what its earlier documents
 * already carried. The sum of a booking's documents is therefore always the accumulated GST, and the booking's GST
 * once it is paid in full (receipt_gst_sums_to_booking_gst).
 */
export function documentGst(input: { bookingGstMinor: bigint; totalMinor: bigint; fundsAfterMinor: bigint; earlierDocumentsGstMinor: bigint }): bigint {
  return cumulativeGst(input.bookingGstMinor, input.totalMinor, input.fundsAfterMinor) - input.earlierDocumentsGstMinor;
}
