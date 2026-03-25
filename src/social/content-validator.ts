import { logger } from './logger.js';
import { Database } from './db.js';
import type { WorkflowEvent, ContentDraft, Platform } from './types.js';

const MODULE = 'content-validator';
const MAX_REVISIONS = 3;

function emit(event: WorkflowEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

interface ValidationRule {
  name: string;
  check: (draft: ContentDraft) => string | null;
}

interface DraftValidationResult {
  draftId: string;
  platform: Platform;
  pass: boolean;
  issues: string[];
}

const SENSITIVE_WORDS = [
  '赌博', '色情', '毒品', '暴力', '诈骗',
  '传销', '非法集资', '洗钱', '走私', '赌场',
];

const PLATFORM_MIN_BODY: Record<Platform, number> = {
  xhs: 50,
  weibo: 20,
  bilibili: 100,
  twitter: 10,
  telegram: 20,
  douyin: 10,
};

const PLATFORM_MAX_BODY: Record<Platform, number> = {
  xhs: 1000,
  weibo: 2000,
  bilibili: 5000,
  twitter: 280,
  telegram: 4096,
  douyin: 1000,
};

/**
 * 平台外链政策：
 * - 'forbidden': 禁止任何外链，包含外链会被限流或删除（小红书、抖音）
 * - 'plain_text': 纯文本 URL 可保留但不可点击，可能触发限流（B站、微博）
 * - 'allowed': 允许外链（Twitter、Telegram）
 */
type LinkPolicy = 'forbidden' | 'plain_text' | 'allowed';

const PLATFORM_LINK_POLICY: Record<Platform, LinkPolicy> = {
  xhs: 'forbidden',
  douyin: 'forbidden',
  bilibili: 'plain_text',
  weibo: 'plain_text',
  twitter: 'allowed',
  telegram: 'allowed',
};

/** 中国大陆平台禁止提及的金融敏感词（加密货币、预测市场等） */
const CHINA_MAINLAND_PLATFORMS: Platform[] = ['xhs', 'weibo', 'bilibili', 'douyin'];

const CRYPTO_KEYWORDS = [
  '加密货币', '虚拟货币', '数字货币', 'crypto', 'cryptocurrency',
  '比特币', 'bitcoin', 'BTC', '以太坊', 'ethereum', 'ETH',
  '币圈', '炒币', '挖矿', '区块链交易', '代币', 'token',
  '预测市场', 'prediction market', 'polymarket', 'Polymarket',
  '合约交易', '杠杆交易', 'DeFi', 'NFT',
];

function buildRules(): ValidationRule[] {
  return [
    {
      name: '敏感词检查',
      check: (draft) => {
        const found = SENSITIVE_WORDS.filter((w) => draft.body.includes(w) || draft.title.includes(w));
        return found.length > 0 ? `包含敏感词：${found.join(', ')}` : null;
      },
    },
    {
      name: '中国大陆平台加密货币/预测市场合规',
      check: (draft) => {
        if (!CHINA_MAINLAND_PLATFORMS.includes(draft.platform)) return null;
        const text = `${draft.title} ${draft.body}`.toLowerCase();
        const found = CRYPTO_KEYWORDS.filter((kw) => text.includes(kw.toLowerCase()));
        if (found.length > 0) {
          return `${draft.platform} 为中国大陆平台，禁止提及加密货币/预测市场相关内容：${found.join(', ')}。建议改为"自动化交易"或"智能投资"等合规表述`;
        }
        return null;
      },
    },
    {
      name: '内容价值性',
      check: (draft) => {
        if (draft.body.trim().length < 10) return '内容为空或过短，缺乏实际价值';
        const uniqueChars = new Set(draft.body.replace(/\s/g, '')).size;
        if (uniqueChars < 10) return '内容重复字符过多，质量不足';
        return null;
      },
    },
    {
      name: '标题吸引力',
      check: (draft) => {
        if (draft.title.trim().length === 0) return '标题为空';
        if (draft.title.trim().length < 4) return '标题过短，缺乏吸引力';
        return null;
      },
    },
    {
      name: '平台格式规范',
      check: (draft) => {
        const minLen = PLATFORM_MIN_BODY[draft.platform];
        const maxLen = PLATFORM_MAX_BODY[draft.platform];

        if (draft.body.length < minLen) {
          return `${draft.platform} 内容长度 ${draft.body.length} < 最低 ${minLen} 字`;
        }
        if (draft.body.length > maxLen) {
          return `${draft.platform} 内容长度 ${draft.body.length} > 最高 ${maxLen} 字`;
        }
        return null;
      },
    },
    {
      name: '标签检查',
      check: (draft) => {
        if (draft.tags.length === 0) return '缺少标签，不利于内容分发';
        return null;
      },
    },
    {
      name: '链接安全',
      check: (draft) => {
        const urlRegex = /https?:\/\/[^\s]+/g;
        const urls = draft.body.match(urlRegex) ?? [];
        const suspicious = urls.filter((u) =>
          u.includes('bit.ly') || u.includes('tinyurl') || u.includes('t.co'),
        );
        if (suspicious.length > 0) {
          return `包含短链接（可能触发平台风控）：${suspicious.join(', ')}`;
        }
        return null;
      },
    },
    {
      name: '平台外链政策',
      check: (draft) => {
        const policy = PLATFORM_LINK_POLICY[draft.platform];
        // Match URLs and domain-like patterns (e.g. github.com/xxx, xxx.dev)
        const urlRegex = /https?:\/\/[^\s]+/g;
        const domainRegex = /(?<!\w)[a-zA-Z0-9-]+\.(com|dev|io|org|net|co|app|me|xyz)(\/[^\s]*)?/g;
        const urls = [
          ...(draft.body.match(urlRegex) ?? []),
          ...(draft.title.match(urlRegex) ?? []),
        ];
        const domains = [
          ...(draft.body.match(domainRegex) ?? []),
          ...(draft.title.match(domainRegex) ?? []),
        ];
        const allLinks = [...new Set([...urls, ...domains])];

        if (allLinks.length === 0) return null;

        if (policy === 'forbidden') {
          return `${draft.platform} 禁止外链，包含以下链接会导致限流/删除：${allLinks.join(', ')}。建议替换为"搜索 XXX"或"主页有链接"`;
        }
        if (policy === 'plain_text') {
          return `${draft.platform} 外链仅显示为纯文本（不可点击），可能触发限流：${allLinks.join(', ')}。建议将链接放在置顶评论或个人简介`;
        }
        return null;
      },
    },
  ];
}

function autoRevise(draft: ContentDraft, issues: string[]): ContentDraft {
  let { body, title, tags } = draft;

  for (const issue of issues) {
    if (issue.includes('敏感词')) {
      for (const word of SENSITIVE_WORDS) {
        body = body.replaceAll(word, '***');
        title = title.replaceAll(word, '***');
      }
    }

    if (issue.includes('加密货币/预测市场合规')) {
      // Replace crypto/prediction market terms with compliant alternatives
      const replacements: [RegExp, string][] = [
        [/加密货币[和与]?预测市场/g, '智能量化策略'],
        [/加密货币/g, '数字资产'],
        [/虚拟货币/g, '数字资产'],
        [/数字货币/g, '数字资产'],
        [/crypto(?:currency)?/gi, '数字资产'],
        [/比特币|bitcoin|BTC/gi, '主流资产'],
        [/以太坊|ethereum|ETH/gi, '主流资产'],
        [/预测市场|prediction market/gi, '智能预测'],
        [/[Pp]olymarket/g, '预测平台'],
        [/币圈/g, '投资圈'],
        [/炒币/g, '量化交易'],
        [/挖矿/g, '算力运营'],
        [/合约交易/g, '量化交易'],
        [/杠杆交易/g, '量化交易'],
        [/代币|token/gi, '资产'],
        [/DeFi/g, '去中心化金融'],
        [/NFT/g, '数字藏品'],
      ];
      for (const [pattern, replacement] of replacements) {
        body = body.replace(pattern, replacement);
        title = title.replace(pattern, replacement);
      }
    }

    if (issue.includes('内容长度') && issue.includes('< 最低')) {
      body = body + '\n\n💡 更多精彩内容，请持续关注！';
    }

    if (issue.includes('内容长度') && issue.includes('> 最高')) {
      const maxLen = PLATFORM_MAX_BODY[draft.platform];
      body = body.slice(0, maxLen - 3) + '...';
    }

    if (issue.includes('标题过短')) {
      title = `📌 ${title} — 必看`;
    }

    if (issue.includes('缺少标签')) {
      tags = [...tags, draft.platform, 'content'];
    }

    if (issue.includes('短链接')) {
      const urlRegex = /https?:\/\/(bit\.ly|tinyurl|t\.co)[^\s]*/g;
      body = body.replace(urlRegex, '[链接已移除]');
    }

    if (issue.includes('禁止外链') || issue.includes('外链仅显示为纯文本')) {
      // Strip full URLs
      body = body.replace(/https?:\/\/[^\s]+/g, '');
      // Replace common domain patterns with search guidance
      body = body.replace(/github\.com\/[^\s]+/g, 'GitHub 搜索项目名');
      body = body.replace(/[a-zA-Z0-9-]+\.dev/g, '');
      body = body.replace(/[a-zA-Z0-9-]+\.(com|io|org|net|co|app)(\/[^\s]*)?/g, '');
      // Clean up leftover whitespace
      body = body.replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  return { ...draft, body, title, tags };
}

export class ContentValidator {
  private db: Database;
  private runId: string;
  private rules: ValidationRule[];

  constructor(db: Database, runId: string) {
    this.db = db;
    this.runId = runId;
    this.rules = buildRules();
  }

  private validateDraft(draft: ContentDraft): DraftValidationResult {
    const issues: string[] = [];

    for (const rule of this.rules) {
      const issue = rule.check(draft);
      if (issue) issues.push(issue);
    }

    return {
      draftId: draft.id,
      platform: draft.platform,
      pass: issues.length === 0,
      issues,
    };
  }

  async run(): Promise<{ approved: number; rejected: number; needsHuman: string[] }> {
    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      stage: 'content-validator',
    });

    const drafts = this.db.getDrafts(this.runId, undefined, 'draft');

    if (drafts.length === 0) {
      logger.info(MODULE, 'no drafts to validate');
      emit({
        ts: new Date().toISOString(),
        event: 'stage:done',
        runId: this.runId,
        stage: 'content-validator',
        data: { approved: 0, rejected: 0, needsHuman: [] },
      });
      return { approved: 0, rejected: 0, needsHuman: [] };
    }

    logger.info(MODULE, 'starting validation', { draftCount: drafts.length });

    let approved = 0;
    let rejected = 0;
    const needsHuman: string[] = [];

    for (const [i, originalDraft] of drafts.entries()) {
      let draft = originalDraft;
      let attempt = 0;
      let lastResult: DraftValidationResult | null = null;

      while (attempt < MAX_REVISIONS) {
        attempt++;
        lastResult = this.validateDraft(draft);

        emit({
          ts: new Date().toISOString(),
          event: 'progress',
          runId: this.runId,
          stage: 'content-validator',
          data: {
            draftId: draft.id,
            platform: draft.platform,
            attempt,
            maxAttempts: MAX_REVISIONS,
            pass: lastResult.pass,
            issues: lastResult.issues,
            current: i + 1,
            total: drafts.length,
          },
        });

        if (lastResult.pass) {
          this.db.updateDraftStatus(draft.id, 'approved');
          approved++;
          logger.info(MODULE, 'draft approved', { id: draft.id, platform: draft.platform, attempt });
          break;
        }

        logger.warn(MODULE, 'draft failed validation', {
          id: draft.id,
          attempt,
          issues: lastResult.issues,
        });

        if (attempt < MAX_REVISIONS) {
          draft = autoRevise(draft, lastResult.issues);
        }
      }

      if (lastResult && !lastResult.pass) {
        const reason = lastResult.issues.join('; ');
        this.db.updateDraftStatus(draft.id, 'rejected', reason);
        rejected++;
        needsHuman.push(draft.id);

        logger.warn(MODULE, 'draft rejected after max revisions', {
          id: draft.id,
          platform: draft.platform,
          reason,
        });
      }
    }

    if (needsHuman.length > 0) {
      emit({
        ts: new Date().toISOString(),
        event: 'approval_needed',
        runId: this.runId,
        stage: 'content-validator',
        data: {
          draftIds: needsHuman,
          message: `${needsHuman.length} 条内容需要人工审核`,
        },
      });
    }

    emit({
      ts: new Date().toISOString(),
      event: 'stage:done',
      runId: this.runId,
      stage: 'content-validator',
      data: { approved, rejected, needsHuman, total: drafts.length },
    });

    logger.info(MODULE, 'validation complete', { approved, rejected, needsHuman: needsHuman.length });

    return { approved, rejected, needsHuman };
  }

  static async main(): Promise<void> {
    const args = process.argv.slice(2);
    const runIdFlag = args.findIndex((a) => a === '--run-id');
    const runId = runIdFlag !== -1 && args[runIdFlag + 1] ? args[runIdFlag + 1] : `validator-${Date.now()}`;

    const db = new Database();
    try {
      const validator = new ContentValidator(db, runId);
      await validator.run();
    } finally {
      db.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ContentValidator.main();
}
