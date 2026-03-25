import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import { Database } from './db.js';
import type { WorkflowEvent, WorkflowConfig, Platform } from './types.js';

const MODULE = 'competitive-analyst';
const ALL_PLATFORMS: Platform[] = ['xhs', 'weibo', 'bilibili', 'twitter', 'telegram', 'douyin'];
const DOCS_DIR = join(process.cwd(), 'docs');

function emit(event: WorkflowEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

interface PlatformTopContent {
  platform: Platform;
  topPosts: TopPost[];
  keywords: string[];
}

interface TopPost {
  title: string;
  url: string;
  views: number;
  likes: number;
  author: string;
}

interface CompetitiveResult {
  niche: string;
  analyzedAt: string;
  platforms: PlatformTopContent[];
  topKeywords: string[];
}

const SKILL_COMMANDS: Record<Platform, string> = {
  xhs: 'xiaohongshu-cli',
  weibo: 'weibo-cli',
  bilibili: 'bilibili-cli',
  twitter: 'twitter-cli',
  telegram: 'telegram-cli',
  douyin: 'douyin-cli',
};

export class CompetitiveAnalyst {
  private db: Database;
  private runId: string;
  private config: WorkflowConfig;

  constructor(db: Database, runId: string, config: WorkflowConfig) {
    this.db = db;
    this.runId = runId;
    this.config = config;
  }

  private invokePlatformSkill(platform: Platform, niche: string): PlatformTopContent {
    const cmd = SKILL_COMMANDS[platform];
    logger.info(MODULE, `analyzing ${platform}`, { cmd, niche });

    try {
      const raw = execSync(
        `npx whipflow skill ${cmd} --action top-content --niche ${JSON.stringify(niche)} --limit 20`,
        { encoding: 'utf-8', timeout: 120_000 },
      );

      const parsed = JSON.parse(raw.trim()) as { posts?: TopPost[]; keywords?: string[] };
      return {
        platform,
        topPosts: (parsed.posts ?? []).slice(0, 20),
        keywords: (parsed.keywords ?? []).slice(0, 30),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(MODULE, `skill ${cmd} failed, returning empty`, { error: message });
      return { platform, topPosts: [], keywords: [] };
    }
  }

  private aggregateKeywords(platforms: PlatformTopContent[]): string[] {
    const freq = new Map<string, number>();
    for (const p of platforms) {
      for (const kw of p.keywords) {
        const normalized = kw.toLowerCase().trim();
        if (normalized.length > 0) {
          freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
        }
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([kw]) => kw);
  }

  private generateMarkdown(result: CompetitiveResult): string {
    const lines: string[] = [
      `# 竞品分析报告`,
      ``,
      `> 方向：${result.niche}`,
      `> 分析时间：${result.analyzedAt}`,
      ``,
      `## 爆款关键词 Top 30`,
      ``,
      ...result.topKeywords.map((kw, i) => `${i + 1}. ${kw}`),
      ``,
    ];

    for (const p of result.platforms) {
      lines.push(`## ${p.platform.toUpperCase()} — TOP 内容`, ``);
      if (p.topPosts.length === 0) {
        lines.push(`_暂无数据_`, ``);
        continue;
      }
      lines.push(`| # | 标题 | 浏览 | 点赞 | 作者 |`);
      lines.push(`|---|---|---|---|---|`);
      for (const [i, post] of p.topPosts.entries()) {
        const title = post.url ? `[${post.title}](${post.url})` : post.title;
        lines.push(`| ${i + 1} | ${title} | ${post.views} | ${post.likes} | ${post.author} |`);
      }
      lines.push(``);

      if (p.keywords.length > 0) {
        lines.push(`**关键词**: ${p.keywords.join(', ')}`, ``);
      }
    }

    return lines.join('\n');
  }

  private saveAnalyticsSnapshots(platforms: PlatformTopContent[]): void {
    const weekNumber = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / 604_800_000);

    for (const p of platforms) {
      const totalViews = p.topPosts.reduce((sum, post) => sum + post.views, 0);
      const totalLikes = p.topPosts.reduce((sum, post) => sum + post.likes, 0);

      this.db.saveAnalytics({
        runId: this.runId,
        weekNumber,
        platform: p.platform,
        followers: 0,
        newFollowers: 0,
        totalViews,
        totalLikes,
        totalComments: 0,
        totalShares: 0,
        engagementRate: totalViews > 0 ? totalLikes / totalViews : 0,
      });
    }

    logger.info(MODULE, 'competitor analytics snapshots saved', { count: platforms.length });
  }

  async run(): Promise<CompetitiveResult> {
    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      stage: 'competitive-analyst',
    });

    const enabledPlatforms = this.config.accounts
      .filter((a) => a.enabled)
      .map((a) => a.platform);

    const targetPlatforms = enabledPlatforms.length > 0
      ? ALL_PLATFORMS.filter((p) => enabledPlatforms.includes(p))
      : ALL_PLATFORMS;

    const platformResults: PlatformTopContent[] = [];

    for (const [i, platform] of targetPlatforms.entries()) {
      emit({
        ts: new Date().toISOString(),
        event: 'progress',
        runId: this.runId,
        stage: 'competitive-analyst',
        data: {
          platform,
          current: i + 1,
          total: targetPlatforms.length,
          percent: Math.round(((i + 1) / targetPlatforms.length) * 100),
        },
      });

      const result = this.invokePlatformSkill(platform, this.config.niche);
      platformResults.push(result);
    }

    const topKeywords = this.aggregateKeywords(platformResults);

    const competitiveResult: CompetitiveResult = {
      niche: this.config.niche,
      analyzedAt: new Date().toISOString(),
      platforms: platformResults,
      topKeywords,
    };

    mkdirSync(DOCS_DIR, { recursive: true });
    const markdown = this.generateMarkdown(competitiveResult);
    writeFileSync(join(DOCS_DIR, 'competitive-analysis.md'), markdown, 'utf-8');
    logger.info(MODULE, 'wrote docs/competitive-analysis.md');

    this.saveAnalyticsSnapshots(platformResults);

    emit({
      ts: new Date().toISOString(),
      event: 'stage:done',
      runId: this.runId,
      stage: 'competitive-analyst',
      data: {
        platformsAnalyzed: platformResults.length,
        topKeywordsCount: topKeywords.length,
        totalPosts: platformResults.reduce((s, p) => s + p.topPosts.length, 0),
      },
    });

    logger.info(MODULE, 'competitive analysis complete', {
      platforms: platformResults.map((p) => p.platform),
      keywords: topKeywords.length,
    });

    return competitiveResult;
  }

  static async main(): Promise<void> {
    const args = process.argv.slice(2);
    const runIdFlag = args.findIndex((a) => a === '--run-id');
    const runId = runIdFlag !== -1 && args[runIdFlag + 1] ? args[runIdFlag + 1] : `competitive-${Date.now()}`;

    const db = new Database();
    try {
      const config = db.getConfig(runId);
      if (!config) {
        logger.error(MODULE, 'no workflow config found — run account-config first', { runId });
        process.exitCode = 1;
        return;
      }

      const analyst = new CompetitiveAnalyst(db, runId, config);
      await analyst.run();
    } finally {
      db.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  CompetitiveAnalyst.main();
}
