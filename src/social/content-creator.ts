import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import { Database } from './db.js';
import type { WorkflowEvent, ContentDraft, Platform } from './types.js';

const MODULE = 'content-creator';
const DOCS_DIR = join(process.cwd(), 'docs');

function emit(event: WorkflowEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface PlatformFormat {
  maxTitleLen: number;
  maxBodyLen: number;
  hashtagPrefix: string;
  separator: string;
  structure: string[];
}

const PLATFORM_FORMATS: Record<Platform, PlatformFormat> = {
  xhs: {
    maxTitleLen: 20,
    maxBodyLen: 1000,
    hashtagPrefix: '#',
    separator: '\n\n',
    structure: ['hook', 'body', 'takeaway', 'hashtags'],
  },
  weibo: {
    maxTitleLen: 0,
    maxBodyLen: 2000,
    hashtagPrefix: '#',
    separator: '\n',
    structure: ['hook', 'body', 'hashtags'],
  },
  bilibili: {
    maxTitleLen: 80,
    maxBodyLen: 5000,
    hashtagPrefix: '#',
    separator: '\n\n',
    structure: ['intro', 'body', 'summary', 'hashtags'],
  },
  twitter: {
    maxTitleLen: 0,
    maxBodyLen: 280,
    hashtagPrefix: '#',
    separator: '\n',
    structure: ['hook', 'body', 'hashtags'],
  },
  telegram: {
    maxTitleLen: 0,
    maxBodyLen: 4096,
    hashtagPrefix: '#',
    separator: '\n\n',
    structure: ['hook', 'body', 'cta', 'hashtags'],
  },
  douyin: {
    maxTitleLen: 30,
    maxBodyLen: 1000,
    hashtagPrefix: '#',
    separator: '\n',
    structure: ['hook', 'body', 'hashtags'],
  },
};

function generateHook(title: string, platform: Platform): string {
  const hooks: Record<Platform, (t: string) => string> = {
    xhs: (t) => `🔥 ${t}`,
    weibo: (t) => `【${t}】`,
    bilibili: (t) => `大家好！今天聊聊 ${t}`,
    twitter: (t) => `${t} 🧵`,
    telegram: (t) => `📌 ${t}`,
    douyin: (t) => `${t} 🔥`,
  };
  return hooks[platform](title);
}

function generateBody(title: string, tags: string[], platform: Platform): string {
  const fmt = PLATFORM_FORMATS[platform];
  const tagList = tags.filter((t) => t.length > 0);

  const sections: string[] = [];

  if (fmt.structure.includes('hook')) {
    sections.push(generateHook(title, platform));
  }

  if (fmt.structure.includes('intro')) {
    sections.push(`今天和大家分享关于「${title}」的内容。`);
  }

  const bodyParagraphs = [
    `在这个话题中，我们需要关注以下几个关键点：`,
    `1️⃣ 核心概念：${title}的本质是什么？`,
    `2️⃣ 实操方法：如何高效地实现目标？`,
    `3️⃣ 避坑指南：常见误区和解决方案`,
  ];

  if (platform === 'twitter') {
    sections.push(bodyParagraphs[0]);
  } else {
    sections.push(bodyParagraphs.join('\n'));
  }

  if (fmt.structure.includes('takeaway')) {
    sections.push(`💡 核心要点：掌握以上${tagList.length > 0 ? tagList[0] : ''}相关技巧，你就能快速上手！`);
  }

  if (fmt.structure.includes('summary')) {
    sections.push(`📝 总结：希望今天的分享对大家有帮助，欢迎在评论区交流！`);
  }

  if (fmt.structure.includes('cta')) {
    sections.push(`👉 有问题欢迎留言讨论！`);
  }

  if (fmt.structure.includes('hashtags') && tagList.length > 0) {
    const hashtags = tagList.map((t) => `${fmt.hashtagPrefix}${t.replace(/\s+/g, '')}`).join(' ');
    sections.push(hashtags);
  }

  let content = sections.join(fmt.separator);

  if (fmt.maxBodyLen > 0 && content.length > fmt.maxBodyLen) {
    content = content.slice(0, fmt.maxBodyLen - 3) + '...';
  }

  return content;
}

function generateTitle(originalTitle: string, platform: Platform): string {
  const fmt = PLATFORM_FORMATS[platform];
  if (fmt.maxTitleLen === 0) return originalTitle;
  if (originalTitle.length <= fmt.maxTitleLen) return originalTitle;
  return originalTitle.slice(0, fmt.maxTitleLen - 1) + '…';
}

export class ContentCreator {
  private db: Database;
  private runId: string;

  constructor(db: Database, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  private getPendingDrafts(calendarDay?: string): ContentDraft[] {
    const drafts = this.db.getDrafts(this.runId, undefined, 'pending' as ContentDraft['status']);
    if (!calendarDay) return drafts;
    return drafts.filter((d) => d.calendarDay === calendarDay);
  }

  private generateDraftContent(draft: ContentDraft): { title: string; body: string } {
    const title = generateTitle(draft.title, draft.platform);
    const body = generateBody(draft.title, draft.tags, draft.platform);
    return { title, body };
  }

  private draftsToMarkdown(drafts: ContentDraft[]): string {
    const lines: string[] = [
      `# 内容草稿`,
      ``,
      `> 生成时间：${new Date().toISOString()}`,
      `> 草稿数量：${drafts.length}`,
      ``,
    ];

    const grouped = new Map<string, ContentDraft[]>();
    for (const d of drafts) {
      const key = d.calendarDay;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(d);
    }

    for (const [day, dayDrafts] of grouped) {
      lines.push(`## ${day}`, ``);

      for (const draft of dayDrafts) {
        lines.push(`### [${draft.platform.toUpperCase()}] ${draft.title}`, ``);
        lines.push(draft.body, ``);
        if (draft.tags.length > 0) {
          lines.push(`**标签**: ${draft.tags.join(', ')}`, ``);
        }
        lines.push(`---`, ``);
      }
    }

    return lines.join('\n');
  }

  async run(calendarDay?: string): Promise<ContentDraft[]> {
    const targetDay = calendarDay ?? todayISO();

    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      stage: 'content-creator',
      data: { calendarDay: targetDay },
    });

    const pending = this.getPendingDrafts(targetDay);

    if (pending.length === 0) {
      logger.info(MODULE, 'no pending drafts for today', { day: targetDay });
      emit({
        ts: new Date().toISOString(),
        event: 'stage:done',
        runId: this.runId,
        stage: 'content-creator',
        data: { created: 0, day: targetDay },
      });
      return [];
    }

    logger.info(MODULE, 'creating content for pending drafts', { count: pending.length, day: targetDay });

    const updated: ContentDraft[] = [];

    for (const [i, draft] of pending.entries()) {
      const { title, body } = this.generateDraftContent(draft);

      this.db.updateDraftStatus(draft.id, 'draft');

      const updatedDraft: ContentDraft = {
        ...draft,
        title,
        body,
        status: 'draft',
      };
      updated.push(updatedDraft);

      emit({
        ts: new Date().toISOString(),
        event: 'progress',
        runId: this.runId,
        stage: 'content-creator',
        data: {
          platform: draft.platform,
          draftId: draft.id,
          current: i + 1,
          total: pending.length,
          percent: Math.round(((i + 1) / pending.length) * 100),
        },
      });

      logger.debug(MODULE, 'draft created', {
        id: draft.id,
        platform: draft.platform,
        titleLen: title.length,
        bodyLen: body.length,
      });
    }

    mkdirSync(DOCS_DIR, { recursive: true });
    const markdown = this.draftsToMarkdown(updated);
    writeFileSync(join(DOCS_DIR, 'content-drafts.md'), markdown, 'utf-8');
    logger.info(MODULE, 'wrote docs/content-drafts.md');

    emit({
      ts: new Date().toISOString(),
      event: 'stage:done',
      runId: this.runId,
      stage: 'content-creator',
      data: {
        created: updated.length,
        day: targetDay,
        platforms: [...new Set(updated.map((d) => d.platform))],
      },
    });

    logger.info(MODULE, 'content creation complete', { created: updated.length });

    return updated;
  }

  static async main(): Promise<void> {
    const args = process.argv.slice(2);
    const runIdFlag = args.findIndex((a) => a === '--run-id');
    const runId = runIdFlag !== -1 && args[runIdFlag + 1] ? args[runIdFlag + 1] : `creator-${Date.now()}`;

    const dayFlag = args.findIndex((a) => a === '--day');
    const day = dayFlag !== -1 && args[dayFlag + 1] ? args[dayFlag + 1] : undefined;

    const db = new Database();
    try {
      const creator = new ContentCreator(db, runId);
      await creator.run(day);
    } finally {
      db.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ContentCreator.main();
}
