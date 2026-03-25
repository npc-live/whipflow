import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import { Database } from './db.js';
import type { WorkflowEvent, WorkflowConfig, PlatformAccount, Platform } from './types.js';

const MODULE = 'account-config';
const ALL_PLATFORMS: Platform[] = ['xhs', 'weibo', 'bilibili', 'twitter', 'telegram', 'douyin'];

const PLATFORM_LABELS: Record<Platform, string> = {
  xhs: '小红书 (XHS)',
  weibo: '微博 (Weibo)',
  bilibili: 'B站 (Bilibili)',
  twitter: 'Twitter',
  telegram: 'Telegram',
  douyin: '抖音 (Douyin)',
};

function emit(event: WorkflowEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

function promptLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export class AccountConfig {
  private db: Database;
  private runId: string;

  constructor(db: Database, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  getConfig(): WorkflowConfig | null {
    return this.db.getConfig(this.runId);
  }

  saveConfig(config: WorkflowConfig): void {
    this.db.saveConfig(this.runId, config);
  }

  getAccounts(): PlatformAccount[] {
    const config = this.getConfig();
    return config?.accounts ?? [];
  }

  setAccount(account: PlatformAccount): void {
    const config = this.getConfig() ?? defaultConfig();
    const idx = config.accounts.findIndex((a) => a.platform === account.platform);
    if (idx >= 0) {
      config.accounts[idx] = account;
    } else {
      config.accounts.push(account);
    }
    this.saveConfig(config);
    logger.info(MODULE, 'account saved', { platform: account.platform, username: account.username });
  }

  removeAccount(platform: Platform): boolean {
    const config = this.getConfig();
    if (!config) return false;
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((a) => a.platform !== platform);
    if (config.accounts.length === before) return false;
    this.saveConfig(config);
    logger.info(MODULE, 'account removed', { platform });
    return true;
  }

  async runInteractive(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });

    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      stage: 'account-config',
    });

    try {
      const config = this.getConfig() ?? defaultConfig();

      process.stderr.write('\n=== 社交平台账号配置 ===\n\n');

      config.niche = (await promptLine(rl, `内容方向 (niche) [${config.niche || '未设置'}]: `)) || config.niche;
      config.targetAudience = (await promptLine(rl, `目标受众 [${config.targetAudience || '未设置'}]: `)) || config.targetAudience;
      config.toneStyle = (await promptLine(rl, `内容调性 [${config.toneStyle || '专业友好'}]: `)) || config.toneStyle || '专业友好';
      config.contentFreq = (await promptLine(rl, `发布频率 [${config.contentFreq || 'daily'}]: `)) || config.contentFreq || 'daily';
      config.growthGoal = (await promptLine(rl, `增长目标 [${config.growthGoal || '未设置'}]: `)) || config.growthGoal;

      process.stderr.write('\n--- 平台账号 ---\n');

      for (const platform of ALL_PLATFORMS) {
        const label = PLATFORM_LABELS[platform];
        const existing = config.accounts.find((a) => a.platform === platform);

        const enable = await promptLine(rl, `启用 ${label}? (y/n) [${existing?.enabled ? 'y' : 'n'}]: `);
        const isEnabled = enable === 'y' || enable === 'Y' || (enable === '' && existing?.enabled === true);

        if (!isEnabled) {
          config.accounts = config.accounts.filter((a) => a.platform !== platform);
          continue;
        }

        const username = (await promptLine(rl, `  ${label} 用户名 [${existing?.username || ''}]: `)) || existing?.username || '';
        const credentialRef = (await promptLine(rl, `  ${label} 凭证引用 [${existing?.credentialRef || ''}]: `)) || existing?.credentialRef || '';

        const idx = config.accounts.findIndex((a) => a.platform === platform);
        const account: PlatformAccount = { platform, username, credentialRef, enabled: true };
        if (idx >= 0) {
          config.accounts[idx] = account;
        } else {
          config.accounts.push(account);
        }
      }

      this.saveConfig(config);
      logger.info(MODULE, 'interactive config saved', {
        niche: config.niche,
        platforms: config.accounts.map((a) => a.platform),
      });

      emit({
        ts: new Date().toISOString(),
        event: 'stage:done',
        runId: this.runId,
        stage: 'account-config',
        data: { platforms: config.accounts.map((a) => a.platform) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(MODULE, 'interactive config failed', { error: message });
      emit({
        ts: new Date().toISOString(),
        event: 'stage:failed',
        runId: this.runId,
        stage: 'account-config',
        data: { error: message },
      });
    } finally {
      rl.close();
    }
  }

  run(): void {
    emit({
      ts: new Date().toISOString(),
      event: 'stage:start',
      runId: this.runId,
      stage: 'account-config',
    });

    const config = this.getConfig();
    if (!config) {
      logger.warn(MODULE, 'no config found — run with --interactive to set up accounts');
      emit({
        ts: new Date().toISOString(),
        event: 'stage:done',
        runId: this.runId,
        stage: 'account-config',
        data: { accounts: [] },
      });
      return;
    }

    const enabledAccounts = config.accounts.filter((a) => a.enabled);
    logger.info(MODULE, 'config loaded', {
      niche: config.niche,
      platforms: enabledAccounts.map((a) => a.platform),
    });

    emit({
      ts: new Date().toISOString(),
      event: 'stage:done',
      runId: this.runId,
      stage: 'account-config',
      data: { accounts: enabledAccounts.map((a) => ({ platform: a.platform, username: a.username })) },
    });
  }

  static async main(): Promise<void> {
    const args = process.argv.slice(2);
    const runIdFlag = args.findIndex((a) => a === '--run-id');
    const runId = runIdFlag !== -1 && args[runIdFlag + 1] ? args[runIdFlag + 1] : `account-config-${Date.now()}`;
    const interactive = args.includes('--interactive');

    const db = new Database();
    try {
      const ac = new AccountConfig(db, runId);
      if (interactive) {
        await ac.runInteractive();
      } else {
        ac.run();
      }
    } finally {
      db.close();
    }
  }
}

function defaultConfig(): WorkflowConfig {
  return {
    niche: '',
    targetAudience: '',
    toneStyle: '专业友好',
    contentFreq: 'daily',
    growthGoal: '',
    accounts: [],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  AccountConfig.main();
}
