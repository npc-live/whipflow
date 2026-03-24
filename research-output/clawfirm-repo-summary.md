# ClawFirm 代码仓库全景分析

> 仓库地址：https://github.com/npc-live/clawfirm
> 分析日期：2026-03-24
> 最新 commit：549f62c (add saas)

---

## 一、项目定位

**ClawFirm 是一个面向「一人公司」的 AI 全链路自动化引擎。**

它不是单一工具，而是一个工具编排平台 + 业务工作流集合。核心理念是：通过 AI 深度嵌入商业全链路，让一个人具备一支团队的执行力，完成从创意到现金流的闭环。

商业形态：CLI 工具管理器（`npm install -g clawfirm`）+ SaaS 后端（`clawfirm.dev`），付费激活 license 后解锁全部功能。

---

## 二、架构总览

```
clawfirm (CLI 工具管理器)
├── openvault        加密本地密钥管理器（Go）
├── skillctl         跨 AI 编程工具同步 skills
├── whipflow         确定性 AI 工作流执行引擎（核心运行时）
└── agent-browser    AI agent 浏览器自动化
```

ClawFirm 本身是壳，实际干活的是 **WhipFlow**。WhipFlow 使用自定义的 `.whip` DSL（基于 OpenProse），定义多 agent 协作工作流，支持：
- 多 agent 角色定义（不同模型、不同工具权限）
- 顺序/条件执行
- 变量传递和上下文拼接
- 自动校验循环（validator agent loop）
- JSON-line 事件协议（对接 Tauri 桌面端）

---

## 三、三大业务线

### 1. 自动化套利交易

| 模块 | 策略 | 关键参数 |
|------|------|----------|
| **polymarket** | 天气温度合约，Open-Meteo 预报 vs 市场隐含概率 | 胜率 57.26%，Sharpe 3.60，最大回撤 10.87% |
| **hyperliquid** | 新闻驱动加密货币永续合约，Claude 评估信号强度 | 单笔 $50，总敞口 $200，3-5x 杠杆，2h 最长持仓 |
| **arbitrage** | 电商跨平台价差（闲鱼↔拼多多 / eBay↔Amazon） | 目标利润率 > 20% |
| **domains** | 扫描过期高价值域名，自动抢注，Sedo/Afternic 出售 | — |

交易模块有独立脚本可脱离 whipflow 直接运行：
- `scripts/hl-news-trader.js` — Hyperliquid 新闻交易（678 行）
- `scripts/weather-trader.js` / `weather-trader-v2.js` — Polymarket 天气交易

### 2. 自媒体矩阵分发

| 模块 | 覆盖 |
|------|------|
| **social-media** | 小红书 / 微博 / B站 / Twitter / Telegram，日更内容 + 多平台发布 + 评论管理 + 周报 |
| **amazon-affiliate** | 关键词研究 → AI 写 SEO 文章 → 自动发布 → 排名监控 |

配套 Skills（Claude Code 可用）：
- `social-publish/` — 各平台内容创作套件（含算法指南、格式规范、爆文模板）
- `video-skills/` — AI 视频制作全链路（脚本分镜 → 数字人 → AI 场景 → TTS → 拼接）

### 3. 全栈软件出海（SaaS）

最新加入的模块，覆盖出海 0→1 全流程：

```
setup（竞品分析 + GTM 策略）
  → landing（英文落地页文案，A/B 版本）
    → acquire（Reddit / HN / Cold Email / SEO 多渠道获客）
      → launch（Product Hunt 发布素材 + 小时级执行计划）
        → monitor（每日反馈监控，紧急反馈自动标记）⟲
          → report（周报：渠道效果 / MRR / 行动计划）
```

---

## 四、工作流标准化设计

所有业务模块遵循统一的 5 文件结构：

| 文件 | 职责 | 运行时机 |
|------|------|----------|
| `setup.whip` | 环境检查、API 验证、写入配置 | 首次使用 |
| `scan.whip` | 拉取数据、识别信号/机会 | 手动或 monitor 触发 |
| `trade.whip` | 风控检查、执行核心动作 | 手动或 monitor 触发 |
| `monitor.whip` | 持续轮询、状态管理 | 长期后台运行 |
| `report.whip` | 统计指标、输出分析报告 | 随时查看 |

另有 `whips/creator/create.whip` — meta-whip，从自然语言描述自动生成新的业务模块子目录。

---

## 五、技术栈

| 层 | 技术 |
|---|---|
| CLI 运行时 | Node.js (ESM)，Bun（WhipFlow 编译） |
| 工作流 DSL | `.whip` 文件（OpenProse 语法） |
| AI 模型 | Claude API（opus / sonnet / haiku 按任务分配） |
| 密钥管理 | openvault（Go，加密本地存储） |
| 链上交互 | viem（EVM 签名/交易） |
| 浏览器自动化 | Chrome DevTools Protocol（原生 WebSocket） |
| 数据库 | SQLite（better-sqlite3） |
| 桌面应用 | Tauri 2.0（Rust + WebView，「社媒运营助手」） |
| Web 端 | Next.js + Fastify（macroflow monorepo） |
| 视频制作 | Remotion |
| 部署 | Fly.io + Vercel |

---

## 六、代码规模

| 目录 | 文件数 | 说明 |
|------|--------|------|
| `bin/` + `lib/` | 7 | CLI 入口 + auth/login/install/dispatch/skills |
| `scripts/` | 3 | 独立交易脚本（~1,300 行） |
| `whips/` | ~35 | 7 个业务模块的 .whip 工作流 |
| `skills/` | ~30+ | AI skills 定义（视频/社媒/文案） |

核心 JS/TS 代码量不大（CLI 壳 + 交易脚本），主要价值在 `.whip` 工作流和 `skills/` 知识库。

---

## 七、密钥与安全

- 推荐用 `openvault` 管理所有密钥，whip 文件内部自动读取
- session 文件权限 `0o600`（仅 owner 可读写）
- 交易脚本有完整风控参数（止损/止盈/最大仓位/最大杠杆）
- README 底部有完整的中英双语免责声明

---

## 八、社区与商业化

- **npm 包**：`@harness.farm/clawfirm`（公开发布）
- **付费 SaaS**：clawfirm.dev（license 激活后解锁 install / new / run）
- **社区**：Discord（discord.gg/JNXz2utFW8）+ 微信（PpCiting）
- **赞助**：GitHub Sponsors（OliviaPp8）
- **License**：MIT

---

## 九、当前状态判断

| 维度 | 状态 |
|------|------|
| CLI 工具管理器 | ✅ 完成，可安装可用 |
| WhipFlow 引擎 | ✅ 完成，DSL 可运行 |
| 交易模块 whips | ✅ 全部就位（polymarket/hyperliquid/arbitrage/domains） |
| 内容模块 whips | ✅ 全部就位（social-media/amazon-affiliate） |
| SaaS 出海 whips | ✅ 刚完成（setup → landing → acquire → launch → monitor → report） |
| Creator meta-whip | ✅ 可用 |
| Skills 体系 | ✅ 社媒发布 + 视频制作全套 |
| 独立交易脚本 | ✅ 可脱离 whipflow 运行 |
| Tauri 桌面应用 | ⚠️ 框架搭好，前端待填充 |
| Macroflow Web 端 | ⚠️ 架构就位，功能待完善 |
| clawfirm.dev 后端 | ❓ 代码不在仓库内，无法评估 |

**总结：ClawFirm 的核心价值——「用 AI 工作流自动化一人公司的赚钱链路」——已经在 whips/ 层面全部落地。7 个业务模块覆盖交易、内容、软件出海三大方向，每个模块都有标准化的 5 文件结构。当前最大的落差在 UI 层（桌面端和 Web 端都是半成品），以及 clawfirm.dev 后端的完成度不可见。**
