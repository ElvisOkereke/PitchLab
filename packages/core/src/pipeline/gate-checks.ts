/**
 * Gate verdicts that only flag (gate.v7 `comps`): a failed one never kills, is never an owner idea's failed check and
 * is never a kill reason; the case, the case writer and the Board show it as a flag, not a failure. No imports, so
 * the web can use it at runtime.
 */
export const ADVISORY_GATE_CHECKS = ['comps'] as const;

export const isAdvisoryGateCheck = (check: string): boolean => (ADVISORY_GATE_CHECKS as readonly string[]).includes(check);
