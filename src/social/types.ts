// ─── Social Platform Automation – Shared Types ───────────────────────────

/** Platforms supported by the social automation pipeline. */
export type Platform = 'xhs' | 'weibo' | 'bilibili' | 'twitter' | 'telegram' | 'douyin';

/** Stage names corresponding to the 12-stage pipeline. */
export type StageName =
  | 'env-setup'
  | 'account-config'
  | 'competitive-analyst'
  | 'strategy-planner'
  | 'content-calendar'
  | 'content-creator'
  | 'content-validator'
  | 'publish-orchestrator'
  | 'analytics-collector'
  | 'insights-engine'
  | 'comment-manager'
  | 'weekly-reporter';

// ─── Workflow Event (stdout JSON-line protocol for Tauri) ────────────────

export interface WorkflowEvent {
  ts: string;           // ISO 8601 timestamp
  event: string;        // e.g. "stage:start", "stage:done", "error"
  runId: string;
  stage?: StageName;
  data?: unknown;
}

// ─── Workflow Config ─────────────────────────────────────────────────────

export interface PlatformAccount {
  platform: Platform;
  username: string;
  /** Opaque credential reference (never stored in plain text). */
  credentialRef: string;
  enabled: boolean;
}

export interface WorkflowConfig {
  niche: string;
  targetAudience: string;
  toneStyle: string;
  contentFreq: string;         // e.g. "daily", "3/week"
  growthGoal: string;
  accounts: PlatformAccount[];
  playwrightToken?: string;
  strategyVersion?: number;
}

// ─── Content Draft ───────────────────────────────────────────────────────

export type DraftStatus = 'draft' | 'approved' | 'rejected' | 'published';

export interface ContentDraft {
  id: string;
  runId: string;
  calendarDay: string;         // YYYY-MM-DD
  platform: Platform;
  title: string;
  body: string;
  tags: string[];
  status: DraftStatus;
  source?: string;             // e.g. "repurpose", "content-creator"
  validationAttempt?: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Publish Log ─────────────────────────────────────────────────────────

export type PublishStatus = 'pending' | 'success' | 'failed';

export interface PublishLogEntry {
  id: string;
  runId: string;
  draftId: string;
  platform: Platform;
  status: PublishStatus;
  postUrl?: string;
  screenshotPath?: string;
  attemptCount: number;
  errorMsg?: string;
  publishedAt?: string;
}

// ─── Analytics Snapshot ──────────────────────────────────────────────────

export interface AnalyticsSnapshot {
  id: string;
  runId: string;
  weekNumber: number;
  platform: Platform;
  followers: number;
  newFollowers: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  engagementRate: number;      // 0–1
  collectedAt: string;
}

// ─── Viral Content ───────────────────────────────────────────────────────

export interface ViralContent {
  id: string;
  runId: string;
  platform: Platform;
  postUrl: string;
  title: string;
  views: number;
  viralScore: number;          // multiplier over average
  patternTags: string[];       // e.g. ["hook-first", "trending-topic"]
  detectedAt: string;
}

// ─── Comment Queue ───────────────────────────────────────────────────────

export type CommentType = 'question' | 'positive' | 'negative' | 'spam' | 'other';
export type ReplyStatus = 'pending' | 'drafted' | 'approved' | 'sent' | 'skipped';

export interface Comment {
  id: string;
  runId: string;
  platform: Platform;
  commentId: string;           // platform-native ID
  postUrl: string;
  body: string;
  author: string;
  likes: number;
  commentType: CommentType;
  replyDraft?: string;
  replyStatus: ReplyStatus;
  createdAt: string;
}

// ─── Stage Run ───────────────────────────────────────────────────────────

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StageRun {
  id: string;
  runId: string;
  stageName: StageName;
  stageIndex: number;          // 0-11
  status: StageStatus;
  inputJson?: string;
  outputJson?: string;
  startedAt?: string;
  finishedAt?: string;
}

// ─── Weekly Report ───────────────────────────────────────────────────────

export interface WeeklyReport {
  id: string;
  runId: string;
  weekNumber: number;
  reportMd: string;            // full markdown content
  insightsJson: string;        // serialised insights object
  createdAt: string;
}
