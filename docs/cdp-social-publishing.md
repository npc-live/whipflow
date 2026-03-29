# CDP 社媒自动发布技术方法论

## 整体架构

三层结构，声明式定义 + 通用执行引擎 + 原生 CDP 传输：

```
YAML 适配层 (adapters/*.yaml)        ← 每个平台一个，声明式步骤定义
    ↓
YAML Runner (yaml-runner.ts)         ← 通用步骤执行引擎 (17种操作)
    ↓
CDP Transport (cdp-client.ts)        ← 原生 WebSocket 连接 Chrome DevTools Protocol
```

不依赖 Puppeteer/Playwright，直接通过 `ws` 库连接 Chrome 的调试端口。

---

## 1. CDP 连接层 (`cdp-client.ts`)

### 连接模型

连接本地 Chrome 实例，需启动时带 `--remote-debugging-port`（默认 9222）。

```
Chrome --remote-debugging-port=9222
  ↕ HTTP (枚举标签页)
  ↕ WebSocket (CDP 命令/响应)
CDPClient
```

### 标签页管理

| 操作 | 端点 | 说明 |
|------|------|------|
| 列举标签页 | `GET http://127.0.0.1:{port}/json` | 获取所有 page 类型标签页 |
| 新建标签页 | `PUT /json/new` | 避免劫持用户当前页面 |
| 智能连接 | `connect(wsUrl?, platformDomain?)` | 优先复用已打开目标域名的标签页 |

### 命令/响应协议

- 自增 `id` 匹配请求与响应
- Pending promise 存 `Map<number, {resolve, reject}>`
- 错误响应 (`msg.error`) 触发 reject

### 高层 CDP 封装

| 方法 | CDP Domain | 用途 |
|------|-----------|------|
| `navigate(url)` | `Page.navigate` | 页面导航 |
| `evaluate(expr)` | `Runtime.evaluate` | 执行 JS，`returnByValue + awaitPromise` |
| `getCookies(urls?)` | `Network.getCookies` | 读取 Cookie 验证登录态 |
| `setFileInputFiles(selector, files)` | `DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles` | 文件上传 |
| `captureScreenshot()` | `Page.captureScreenshot` | 截图 (PNG base64) |
| `dispatchKeyEvent(type, opts)` | `Input.dispatchKeyEvent` | 模拟键盘事件 |
| `insertText(text)` | `Input.insertText` | 光标处插入文本 |

---

## 2. 会话持久化 (`cdp-session.ts`)

Cookie 持久化到本地磁盘，实现"登录一次，长期复用"。

```
~/.cdp-scraper/sessions/{platform}.json   ← 序列化的 Cookie 数组
```

### 流程

1. **恢复会话**：加载本地 Cookie → 逐条 `Network.setCookie` 注入浏览器
2. **验证登录**：`Network.getCookies` 检查目标域名的关键 Cookie 是否存在
3. **保存会话**：命令成功执行后 `Network.getAllCookies` 写回磁盘
4. **降级处理**：Cookie 失效时仅 warn，不阻断执行（允许手动登录）

---

## 3. YAML 步骤引擎 (`yaml-runner.ts`)

核心执行引擎，加载平台 YAML 适配文件，按步骤序列执行 CDP 操作。

### 适配文件加载顺序

1. `./adapters/{platform}.yaml`（本地优先）
2. `node_modules/@harness.farm/social-cli/adapters/{platform}.yaml`（npm 包回退）

### 17 种步骤类型

| 步骤 | CDP 机制 | 说明 |
|------|---------|------|
| `open` | `Page.navigate` | 导航到 URL，支持 `{{var}}` 插值 |
| `wait` | `setTimeout` 或轮询 `Runtime.evaluate` | 等待 N ms 或等待 CSS 选择器出现（500ms 轮询，30s 超时）|
| `click` | `Runtime.evaluate` + `querySelector().click()` | CSS 选择器点击，或文本内容匹配点击 |
| `fill` | `Runtime.evaluate` + 原生 setter hack | 填充 `<input>`/`<textarea>`，绕过 React 受控组件 |
| `type_rich` | `focus` + `execCommand` 清空 + `Input.insertText` | contenteditable 元素输入 |
| `eval` | `Runtime.evaluate` | 执行任意 JS |
| `capture` | `Runtime.evaluate` 存变量 | 求值并存入命名变量，供后续插值 |
| `extract` | `Runtime.evaluate` | 从多个元素提取结构化数据（如搜索结果抓取）|
| `return` | 变量插值 | 从捕获变量构建返回结果表 |
| `upload` | `DOM.setFileInputFiles` | 上传文件到 file input |
| `key` | `Input.dispatchKeyEvent` | 按键/组合键（Enter, Tab, Control+Enter 等）|
| `keyboard_insert` | 逐字符 `dispatchKeyEvent`，20ms 间隔 | 模拟人类打字速度 |
| `insert_text` | `Input.insertText` | 光标处批量文本插入 |
| `screenshot` | `Page.captureScreenshot` | 页面截图 |
| `assert` | `Runtime.evaluate` | 断言 JS 条件为真，否则抛错 |

### 模板插值

所有字符串值支持 `{{variable}}` 语法：
- 先简单变量查找
- 失败则回退到 `new Function()` 求值（支持表达式如 `{{flag == 'true' && 'A' || 'B'}}`）

### 登录验证流程

```
runCommand(platform, command, args, cdp)
  → 检查 adapter.login_check.cookie 定义
  → 有 session 文件？→ Network.setCookie 注入
  → Network.getCookies 验证关键 Cookie
  → Cookie 缺失？→ warn（不阻断，允许手动登录）
  → 执行步骤序列
  → 成功后 captureSession 保存 Cookie
```

---

## 4. 关键技巧

### 4.1 React 受控输入绕过 (`fill` 步骤)

React/Vue 等框架的受控组件会拦截 `.value` 赋值，直接设置不会触发状态更新。

**解法**：调用原生 property setter + 手动派发事件

```javascript
// 获取原生 setter（绕过框架的 getter/setter 劫持）
const nativeSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype, 'value'
).set;

// 用原生 setter 设置值
nativeSetter.call(element, value);

// 手动触发事件，让框架感知到变化
element.dispatchEvent(new Event('input', { bubbles: true }));
element.dispatchEvent(new Event('change', { bubbles: true }));
```

### 4.2 contenteditable 输入 (`type_rich` 步骤)

Twitter 等平台的编辑框是 `contenteditable` div，不是标准 `<input>`。

**解法**：focus → 全选清空 → CDP insertText

```javascript
// 1. 聚焦元素
element.focus();

// 2. 全选并删除已有内容
document.execCommand('selectAll');
document.execCommand('delete');

// 3. 通过 CDP Input.insertText 注入文本
// 这样编辑器的事件监听能正确触发（比直接改 innerHTML 可靠）
cdp.send('Input.insertText', { text: content });
```

### 4.3 文件上传（无需 `<input type="file">` 可见）

```javascript
// 通过 DOM 域直接设置文件路径，绕过文件选择对话框
cdp.send('DOM.getDocument');
const nodeId = cdp.send('DOM.querySelector', { selector: 'input[type=file]' });
cdp.send('DOM.setFileInputFiles', { nodeId, files: ['/path/to/file'] });
```

### 4.4 视频上传等待

轮询检测上传进度，最多等待 120 秒：

```
循环 60 次，每次 2s：
  → 检测进度条是否消失
  → 检测缩略图是否出现
  → 两者满足 → 上传完成
```

---

## 5. 推特完整发帖流程 (`adapters/x.yaml`)

### 文本帖 (`post`)

```yaml
steps:
  - open: https://x.com/home
  - wait: 3000                                        # 等待页面加载
  - type_rich:
      selector: "[data-testid='tweetTextarea_0']"     # 聚焦编辑框 → 清空 → insertText
      text: "{{content}}"
  - wait: 500
  - capture: input_text                                # 读回 textContent 验证写入
  - click: "[data-testid='tweetButton']"               # 点击发布
  - wait: 2500
  - capture: result_url                                # 获取 location.href
```

### 视频帖 (`post_video`)

在文本帖基础上增加：
```yaml
  - upload:
      selector: "input[data-testid='fileInput']"       # DOM.setFileInputFiles
      file: "{{video_path}}"
  - wait:                                              # 轮询等待视频处理
      poll: 60                                         # 最多 60 次
      interval: 2000                                   # 每次 2s
      condition: "进度条消失 && 缩略图出现"
```

### 其他命令

| 命令 | 流程 |
|------|------|
| `reply` | 打开推文 URL → 点击回复按钮 → type_rich 写入 → 点击提交 |
| `search` | 导航到搜索 URL → extract 抓取推文卡片（文本/用户/链接/时间）|
| `like` / `retweet` | 导航到推文 → 点击对应 testid 按钮 |

---

## 6. 发布编排 (`publish-orchestrator.ts`)

### 多平台并行发布

```
PublishOrchestrator
  → 查询 SQLite: 今日 status='approved' 的 draft
  → Promise.allSettled([
       PublisherTwitter   → CDPClient → yaml-runner → x.yaml
       PublisherXhs       → CDPClient → yaml-runner → xhs.yaml
       PublisherWeibo     → [Playwright MCP stub]
       PublisherBilibili  → [Playwright MCP stub]
       PublisherTelegram  → [Playwright MCP stub]
     ])
  → 每个 draft: 最多 2 次重试，指数退避 (2s, 4s)
  → SQLite: 更新 draft status + 写入 publish_log
  → stdout: JSON-line WorkflowEvent → Tauri UI
```

### 平台内容格式化

| 平台 | 限制 | 特殊处理 |
|------|------|---------|
| Twitter | 280 字符/条 | 超长自动拆分为 thread，最多 3 个 hashtag |
| 小红书 | 标题 20 字，正文 1000 字 | 最多 10 个 hashtag |
| 微博 | 正文 2000 字 | 双井号格式 `#话题#`，最多 5 个 |
| B站 | 标题 40 字，正文 25000 字 | 最多 12 个 tag |
| Telegram | 总长 4096 字 | 粗体标题 `**title**`，hashtag 空格替换为下划线 |

---

## 7. 当前实现状态

| 平台 | 自动化方式 | Publisher 代码 | YAML 适配 | 状态 |
|------|-----------|---------------|-----------|------|
| Twitter/X | CDP + WebSocket | 完整 | `x.yaml` 完整 | **可用** |
| 小红书 | CDP + WebSocket | 完整 | `xhs.yaml` 缺失 | 半成品 |
| 微博 | Playwright MCP | Stub | 无 | 占位 |
| B站 | Playwright MCP | Stub | 无 | 占位 |
| Telegram | Playwright MCP | Stub | 无 | 占位 |

---

## 8. 设计决策与取舍

- **选择原生 CDP 而非 Puppeteer**：更轻量，无额外依赖，复用用户已登录的浏览器实例
- **YAML 声明式适配**：新增平台只需写 YAML，不改引擎代码；非工程师也能维护
- **Cookie 持久化 vs OAuth**：社媒平台多不开放 posting API，Cookie 方案是唯一可行路径
- **并行发布 + 独立重试**：一个平台失败不影响其他平台，指数退避避免触发限流
- **两套自动化策略共存**：CDP (Twitter/XHS) + Playwright MCP (其余平台)，逐步迁移
