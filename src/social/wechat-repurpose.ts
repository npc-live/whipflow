import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import { Database } from './db.js';
import type { WorkflowEvent, WorkflowConfig, ContentDraft, Platform } from './types.js';

const MODULE = 'wechat-repurpose';
const DOCS_DIR = join(process.cwd(), 'docs');
const MAX_REVISIONS = 2;

function emit(event: WorkflowEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

interface RepurposedContent {
  platform: Platform;
  title: string;
  body: string;
  tags: string[];
}

interface PlatformAdapter {
  maxLen: number;
  reformat: (title: string, markdown: string, tags: string[]) => RepurposedContent;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '微信文章改写';
}

function extractTags(markdown: string): string[] {
  const tags: string[] = [];
  const headerMatches = markdown.matchAll(/^#{1,3}\s+(.+)$/gm);
  for (const m of headerMatches) {
    const text = m[1].trim();
    if (text.length <= 10 && text.length >= 2) {
      tags.push(text);
    }
  }
  return [...new Set(tags)].slice(0, 10);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function stripMarkdownFormatting(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/!\[.*?\]\(.*?\)/g, '[图片]')
    .replace(/\[(.+?)\]\(.*?\)/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^>\s+/gm, '')
    .replace(/---+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ADAPTERS: Record<Platform, PlatformAdapter> = {
  xhs: {
    maxLen: 1000,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const sections = plain.split('\n\n').filter(Boolean);
      const hook = `🔥 ${title}`;
      const body = sections.slice(0, 5).join('\n\n');
      const hashtags = tags.map((t) => `#${t}`).join(' ');
      const full = truncate([hook, body, '💡 收藏备用！', hashtags].join('\n\n'), 1000);
      return { platform: 'xhs', title: truncate(title, 20), body: full, tags };
    },
  },
  weibo: {
    maxLen: 2000,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const hook = `【${title}】`;
      const body = truncate(plain, 1800);
      const hashtags = tags.slice(0, 3).map((t) => `#${t}#`).join(' ');
      return { platform: 'weibo', title, body: [hook, body, hashtags].join('\n'), tags };
    },
  },
  bilibili: {
    maxLen: 5000,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const intro = `大家好！今天分享一篇关于「${title}」的深度内容。`;
      const body = truncate(plain, 4500);
      const outro = `📝 以上就是今天的分享，如果觉得有用请一键三连！`;
      const hashtags = tags.map((t) => `#${t}`).join(' ');
      return {
        platform: 'bilibili',
        title: truncate(title, 80),
        body: [intro, body, outro, hashtags].join('\n\n'),
        tags,
      };
    },
  },
  twitter: {
    maxLen: 280,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const firstParagraph = plain.split('\n\n')[0] ?? '';
      const hashtags = tags.slice(0, 2).map((t) => `#${t}`).join(' ');
      const tweet = truncate(`${title}\n\n${firstParagraph}\n\n${hashtags}`, 280);
      return { platform: 'twitter', title, body: tweet, tags };
    },
  },
  telegram: {
    maxLen: 4096,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const hook = `📌 ${title}`;
      const body = truncate(plain, 3800);
      const cta = `👉 有什么想法？欢迎留言讨论！`;
      const hashtags = tags.map((t) => `#${t}`).join(' ');
      return {
        platform: 'telegram',
        title,
        body: [hook, body, cta, hashtags].join('\n\n'),
        tags,
      };
    },
  },
  douyin: {
    maxLen: 1000,
    reformat: (title, markdown, tags) => {
      const plain = stripMarkdownFormatting(markdown);
      const firstParagraphs = plain.split('\n\n').filter(Boolean).slice(0, 3).join('\n');
      const hashtags = tags.slice(0, 8).map((t) => `#${t}`).join(' ');
      const body = truncate(`${title} 🔥\n${firstParagraphs}\n${hashtags}`, 1000);
      return { platform: 'douyin', title: truncate(title, 30), body, tags };
    },
  },
};

function validateRepurposed(content: RepurposedContent): string[] {
  const issues: string[] = [];
  const adapter = ADAPTERS[content.platform];

  if (content.body.length > adapter.maxLen) {
    issues.push(`${content.platform} 超出字数限制 (${content.body.length}/${adapter.maxLen})`);
  }
  if (content.body.trim().length < 10) {
    issues.push(`${content.platform} 内容过短`);
  }
  if (content.title.trim().length === 0) {
    issues.push(`${content.platform} 标题为空`);
  }

  return issues;
}

export class WechatRepurpose {
  private db: Database;
  private runId: string;
  private config: WorkflowConfig;

  constructor(db: Database, runId: string, config: WorkflowConfig) {
    this.db = db;
    this.runId = runId;
    this.config = config;
  }

  private fetchArticle(url: string): string {
    logger.info(MODULE, 'fetching wechat article', { url });

    try {
      const raw = execSync(
        `npx whipflow skill wechat-article-to-markdown --url ${JSON.stringify(url)}`,
        { encoding: 'utf-8', timeout: 60_000 },
      );
      return raw.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(MODULE, 'failed to fetch article', { url, error: message });
      throw new Error(`无法获取微信文章: ${message}`);
    }
  }

  private getTargetPlatforms(): Platform[] {
    const enabled = this.config.accounts
      .filter((a) => a.enabled)
      .map((a) => a.platform);
    return enabled.length > 0 ? enabled : ['xhs', 'weibo', 'bilibili', 'twitter', 'telegram'];
  }

  private repurpose(markdown: string, platforms: Platform[]): RepurposedContent[] {
    const title = extractTitle(markdown);
    const tags = extractTags(markdown);
    const results: RepurposedContent[] = [];

    for (const platform of platforms) {
      const adapter = ADAPTERS[platform];
      let content = adapter.reformat(title, markdown, tags);

      let revision = 0;
      while (revision < MAX_REVISIONS) {
        const issues = validateRepurposed(content);
        if (issues.length === 0) break;

        revision++;
        logger.warn(MODULE, `revision ${revision} for ${platform}`, { issues });

        content = {
          ...content,
          body: truncate(content.body, adapter.maxLen),
          title: content.title || title,
        };
      }

      results.push(content);
    }

    return results;
  }

  private saveToDb(contents: RepurposedContent[]): string[] {
    const today = new Date().toISOString().slice(0, 10);
    const ids: string[] = [];

    for (const content of contents) {
      const draft: Omit<ContentDraft, 'id' | 'createdAt' | 'updatedAt'> = {
        runId: this.runId,
        calendarDay: today,
        platform: content.platform,
        title: content.title,
        body: content.body,
        tags: content.tags,
        status: 'draft',
        source: 'wechat',
        validationAttempt: 0,
      };

      const id = this.db.insertDraft(draft);
      ids.push(id);
    }

    return ids;
  }

  private toMarkdown(contents: RepurposedContent[], sourceUrl: string): string {
    const lines: string[] = [
      `# 微信文章改写`,
      ``,
      `> 原文：${sourceUrl}`,
      `> 生成时间：${new Date().toISOString()}`,
      `> 平台数：${contents.length}`,
      ``,
    ];

    for (const c of contents) {
      lines.push(`## ${c.platform.toUpperCase()}`, ``);
      if (c.title) lines.push(`**标题**: ${c.title}`, ``);
      lines.push(c.body, ``);
      if (c.tags.length > 0) {
        lines.push(`**标签**: ${c.tags.join(', ')}`, ``);
      }
      lines.push(`---`, ``);
    }

    return lines.join('\n');
  }

  async run(wechatUrl: string): Promise<RepurposedContent[]> {
    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      data: { wechatUrl },
    });

    const markdown = this.fetchArticle(wechatUrl);
    logger.info(MODULE, 'article fetched', { length: markdown.length });

    const platforms = this.getTargetPlatforms();
    logger.info(MODULE, 'target platforms', { platforms });

    emit({
      ts: new Date().toISOString(),
      event: 'progress',
      runId: this.runId,
      data: { step: 'repurposing', platforms, articleLength: markdown.length },
    });

    const contents = this.repurpose(markdown, platforms);

    const draftIds = this.saveToDb(contents);
    logger.info(MODULE, 'drafts saved to db', { count: draftIds.length });

    mkdirSync(DOCS_DIR, { recursive: true });
    const mdOutput = this.toMarkdown(contents, wechatUrl);
    writeFileSync(join(DOCS_DIR, 'repurposed-content.md'), mdOutput, 'utf-8');
    logger.info(MODULE, 'wrote docs/repurposed-content.md');

    emit({
      ts: new Date().toISOString(),
      event: 'stage:done',
      runId: this.runId,
      data: {
        sourceUrl: wechatUrl,
        platforms: contents.map((c) => c.platform),
        draftIds,
      },
    });

    logger.info(MODULE, 'repurpose complete', { platforms: contents.length });

    return contents;
  }

  static async main(): Promise<void> {
    const args = process.argv.slice(2);
    const runIdFlag = args.findIndex((a) => a === '--run-id');
    const runId = runIdFlag !== -1 && args[runIdFlag + 1] ? args[runIdFlag + 1] : `repurpose-${Date.now()}`;

    const urlFlag = args.findIndex((a) => a === '--url');
    const url = urlFlag !== -1 && args[urlFlag + 1] ? args[urlFlag + 1] : undefined;

    if (!url) {
      logger.error(MODULE, 'missing --url parameter');
      process.exitCode = 1;
      return;
    }

    const db = new Database();
    try {
      const config = db.getConfig(runId);
      if (!config) {
        logger.error(MODULE, 'no workflow config found — run account-config first', { runId });
        process.exitCode = 1;
        return;
      }

      const repurpose = new WechatRepurpose(db, runId, config);
      await repurpose.run(url);
    } finally {
      db.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  WechatRepurpose.main();
}
