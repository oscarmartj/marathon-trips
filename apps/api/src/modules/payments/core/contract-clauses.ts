// The clauses of the payment adapter contract suite (plan docs/plans/3.6-adapter-contract-suite.md, sections 2.2 and
// 10). The suite in test/contract/ implements exactly these, once each. The list also sets the evidence a verified
// adapter needs: a docs/done/ line "test:sandbox <key> <YYYY-MM-DD> N/N" where N is the length of this list, so adding
// a clause makes every verified adapter run its sandbox again.
export const CONTRACT_CLAUSES = [
  'context_is_test_mode',
  'manifest_is_valid',
  'create_input_has_no_card_fields',
  'create_returns_normalised_payment',
  'same_idempotency_key_same_object',
  'same_key_other_amount_never_a_second_object',
  'different_keys_different_objects',
  'definitive_refusal_means_no_object',
  'retrieve_by_ref_and_by_key_agree',
  'retrieve_unknown_is_null',
  'customer_payment_reflected',
  'failed_is_terminal',
  'terminal_state_is_final',
  'succeeded_is_final',
  'cancel_is_idempotent_and_final',
  'cancel_unknown_is_not_found',
  'statuses_only_move_forward',
  'webhook_verifies_and_matches_retrieve',
  'webhook_previous_state_and_duplicate',
  'webhook_rejections',
  'verify_and_parse_never_throw',
  'test_connection_reports_not_throws',
  'bad_credentials_are_auth_failed',
  'refund_full_and_idempotent',
  'refund_partial_follows_capability',
  'refund_over_amount_refused',
  'refund_of_unpaid_payment_refused',
  'refund_retrieve_by_ref_and_key_agree',
  'refund_webhook_verifies_and_resolves_payment',
  'gateway_refund_has_no_our_id',
  // Task 4.5: they apply when the manifest declares `disputes`; otherwise each checks that nothing dispute-like is claimed.
  'dispute_webhook_verifies_and_resolves_payment',
  'dispute_retrieve_matches_webhook',
  'dispute_funds_flags_are_cumulative',
  'refund_of_disputed_payment_refused',
  'no_secret_in_results_or_errors',
  // Task 4.6: they apply when the manifest declares `reconciliation`; otherwise each checks the methods are absent.
  'activity_lists_what_was_collected',
  'settlement_totals_and_lines_consistent',
] as const;

export type ContractClause = (typeof CONTRACT_CLAUSES)[number];

/** The evidence line a sandbox run prints (scripts/sandbox-evidence.ts) and a verified manifest's evidence file holds. */
export const sandboxEvidenceLine = (key: string, date: string, passed: number): string => `test:sandbox ${key} ${date} ${passed}/${CONTRACT_CLAUSES.length}`;
