/** Readable names of the gate checks (board gate kills, case summary). Unknown checks show their raw name. */
export const CHECK_LABEL: Record<string, string> = {
  generic: 'Not generic',
  regulation: 'Regulation',
  control: 'Control',
  autonomy: 'Autonomy',
  reachability: 'Reachability',
  evidence: 'Evidence',
  scale: 'Revenue ceiling',
  trivial: 'Not trivial',
  comps: 'Comps',
};

export const checkLabel = (check: string) => CHECK_LABEL[check] ?? check;
