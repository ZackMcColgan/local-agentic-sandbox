export interface PrePrGateInput {
  flowChecksPassed: boolean;
  reviewerApproved: boolean;
  gatePassed: boolean;
}

export interface PrePrGateResult {
  ready: boolean;
  reasons: string[];
}

export function evaluatePrePrGate(input: PrePrGateInput): PrePrGateResult {
  const reasons: string[] = [];
  if (!input.flowChecksPassed) {
    reasons.push("FlowMonitor checks have not passed.");
  }
  if (!input.reviewerApproved) {
    reasons.push("ReviewerGate has not approved.");
  }
  if (!input.gatePassed) {
    reasons.push("Test gate has not passed.");
  }
  return { ready: reasons.length === 0, reasons };
}
