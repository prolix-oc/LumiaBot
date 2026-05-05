export interface ResolvedUserMention {
  userId: string;
  username: string;
  displayName: string;
  mention: string;
  source: 'current-message' | 'memory' | 'guild-search';
  matchScore?: number;
}

export type ResolveUserMention = (query: string, maxResults?: number) => Promise<ResolvedUserMention[]>;
