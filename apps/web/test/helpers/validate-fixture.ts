import type { ProspectRow, ValidateView } from '@bcg/core/dashboard/validate-view';
import { emptyOutreachCounts } from '@bcg/core/validation/tracking';
import type { LandingCopy, PackDocs } from '@bcg/core/validation/schema';

const NOW = new Date('2026-10-19T12:00:00Z');

export function packFixture(): PackDocs {
  return {
    mvpSpec: {
      summary: 'A lead-flow checker for agencies',
      features: [
        { name: 'Form runner', why: 'submits the test lead', manualAtFirst: false },
        { name: 'Inbox check', why: 'confirms delivery', manualAtFirst: true },
        { name: 'Monthly report', why: 'proves the retainer', manualAtFirst: true },
      ],
      architectureSketch: 'One worker, one database.',
      buildEstimate: { lowDays: 5, highDays: 12, assumptions: ['one engineer'] },
      fakeOrManualFirst: ['send reports by hand'],
      risks: ['agencies may not pay'],
      packaging: '$8 per site per month',
    },
    pilotPlan: {
      idealPilotCustomer: 'An agency with 40 client sites', firstStep: 'Agree the scope.', steps: ['a', 'b', 'c'],
      measures: [{ metric: 'leads caught', successThreshold: '1 per month' }, { metric: 'renewal', successThreshold: 'yes' }], timelineWeeks: 4,
      permissionsAndRisks: ['Written permission from each site owner first'],
    },
    interviewKit: {
      targetRoles: ['Agency owner'], whereToFind: ['Agency forums'], opening: 'Hi',
      questions: Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i + 1}?`, whyAsk: 'why', listenFor: 'listen' })), redFlags: ['no budget'],
    },
    checklist: {
      gates: [
        { id: 'sent', description: 'Send 50 emails', metricKey: 'emails_sent', threshold: 50 },
        { id: 'positive', description: '3 positive replies', metricKey: 'positive_replies', threshold: 3 },
      ],
    },
  };
}

export const landingCopyFixture: LandingCopy = {
  headline: 'Never lose a lead to a broken form', subhead: 'Daily checks', whoItsFor: 'Web agencies', problem: 'Forms fail silently',
  howItWorks: [{ title: 'Run', text: 'We submit' }, { title: 'Check', text: 'We confirm' }, { title: 'Alert', text: 'We tell you' }],
  offer: 'First month free', faq: [{ q: 'q1', a: 'a1' }, { q: 'q2', a: 'a2' }, { q: 'q3', a: 'a3' }], ctaLabel: 'Join', metaDescription: 'm',
};

let n = 0;
export function prospectRow(o: Partial<ProspectRow> = {}): ProspectRow {
  n += 1;
  return {
    id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`, caseId: '33333333-3333-4333-8333-333333333333', name: `Agency ${n}`,
    website: `https://agency${n}.example`, domain: `agency${n}.example`, location: 'Toronto, ON', country: 'CA', sizeNote: null,
    fitReason: 'Maintains 40 sites', contactName: null, contactRole: null, email: `hello@agency${n}.example`, emailSourceUrl: null,
    emailCapturedAt: null, caslBasis: 'self_published', source: 'manual', status: 'drafted', createdAt: NOW, ...o,
  };
}

export function validateViewFixture(o: Partial<ValidateView> = {}): ValidateView {
  return {
    pack: { id: 'p', caseId: '33333333-3333-4333-8333-333333333333', sections: packFixture(), model: 'claude-x', promptVersion: 'pack.v1', createdAt: NOW, updatedAt: NOW },
    prospects: { rows: [], total: 0 },
    drafts: new Map(),
    events: [],
    landing: null,
    checklist: [
      { id: 'sent', description: 'Send 50 emails', metricKey: 'emails_sent', value: 50, threshold: 50, state: 'pass' },
      { id: 'positive', description: '3 positive replies', metricKey: 'positive_replies', value: 1, threshold: 3, state: 'pending' },
    ],
    counts: emptyOutreachCounts(),
    ...o,
  };
}
