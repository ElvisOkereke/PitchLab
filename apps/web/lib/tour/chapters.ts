// The tour's chapters. Every title and body is a string literal: driver.js renders them with innerHTML, so no step
// text may ever come from case, prospect, LLM or user data.
// Placeholder content: each chapter has one centred welcome step until the real chapters are written.
import type { TourChapterId } from '@bcg/core/dashboard/tour';
import type { TourStep } from './machine';

export const CHAPTERS: Record<TourChapterId, { title: string; steps: TourStep[] }> = {
  setup: {
    title: 'Set up',
    steps: [{ id: 'setup-welcome', route: '/', title: 'Welcome to PitchLab', body: 'This short tour shows you around. Press Next to continue, or close it any time.', kind: 'info' }],
  },
  generate: {
    title: 'Generate ideas',
    steps: [{ id: 'generate-intro', route: '/', title: 'Generate ideas', body: 'This chapter shows you how to start a run.', kind: 'info' }],
  },
  board: {
    title: 'The board',
    steps: [{ id: 'board-intro', route: '/', title: 'The board', body: 'This chapter shows you the board.', kind: 'info' }],
  },
  read: {
    title: 'Read a case',
    steps: [{ id: 'read-intro', route: '/', title: 'Read a case', body: 'This chapter shows you how to read a case.', kind: 'info' }],
  },
  score: {
    title: 'Score it',
    steps: [{ id: 'score-intro', route: '/', title: 'Score it', body: 'This chapter shows you how to score a case.', kind: 'info' }],
  },
  validate: {
    title: 'Validate it',
    steps: [{ id: 'validate-intro', route: '/', title: 'Validate it', body: 'This chapter shows you how to validate a case.', kind: 'info' }],
  },
  outreach: {
    title: 'Contact prospects',
    steps: [{ id: 'outreach-intro', route: '/', title: 'Contact prospects', body: 'This chapter shows you how to log outreach.', kind: 'info' }],
  },
  decide: {
    title: 'Decide',
    steps: [{ id: 'decide-intro', route: '/', title: 'Decide', body: 'This chapter shows you how to move a case on or kill it.', kind: 'info' }],
  },
};
