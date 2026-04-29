export const AGENT_ELIGIBLE_LABEL = "agent-eligible";

export function hasAgentEligibleLabel(labels: string[]): boolean {
  return labels.includes(AGENT_ELIGIBLE_LABEL);
}
