// The fixed tags the owner can put on an idea (web-safe: no runtime imports).
export const OWNER_IDEA_TAGS = [
  'too niche', 'no edge', 'not scalable', 'already exists', 'boring', 'platform-dependent', 'wordpress or plugin', 'love it', 'would build',
] as const;
export type OwnerIdeaTag = (typeof OWNER_IDEA_TAGS)[number];
