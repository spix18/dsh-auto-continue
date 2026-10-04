# dsh-auto-continue

[![npm version](https://img.shields.io/npm/v/dsh-auto-continue?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-auto-continue)
[![npm downloads](https://img.shields.io/npm/dm/dsh-auto-continue?color=cb3837)](https://www.npmjs.com/package/dsh-auto-continue)
[![license](https://img.shields.io/npm/l/dsh-auto-continue?color=blue)](https://github.com/spix18/dsh-auto-continue/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/spix18/dsh-auto-continue?color=yellow)](https://github.com/spix18/dsh-auto-continue)

> **DeepSeek Harness（DSH）自动续跑插件** —— 遇到 429 限流、配额耗尽或空响应时，插件等待片刻后**自动替你发送 `continue`**，让长任务扛过一次 429 而不是直接中断。它会一直重试到该轮成功，或达到你设定的连续失败上限；任何一轮正常结束都会把计数清零。

[English →](README.md)

## 📦 安装

**环境要求：** Node ≥ 20 · DSH ≥ 0.2.0-rc.2

```bash
# 1. 把插件装进你的 DSH profile
dsh plugin --profile web add dsh-auto-continue

# 2. 重启 DSH（浏览器端在启动时加载）
# 3. 打开侧边栏  设置 → Auto-Continue  即可配置
```

就这么多 —— 快捷开关会立刻出现在输入区底部，插件已按默认值开始工作。**连续失败上限**可设为 1–100（默认 20），如果服务商返回了不常见的错误码，也可以自己加进列表。

<details>
<summary>其它安装方式 / 自检</summary>

```bash
# 从本地 checkout 安装（可编辑）
git clone https://github.com/spix18/dsh-auto-continue
dsh plugin --profile web add "file:$PWD/dsh-auto-continue"

# 装到 headless profile
dsh plugin --profile headless add dsh-auto-continue

# 跑验证脚本（52 条断言，覆盖两端，不需要启动 DSH）
node test/run.mjs
```

如果是从 checkout 安装的，改完代码后重新执行
`dsh plugin --profile web add "file:$PWD/dsh-auto-continue"`，然后重启 DSH。
</details>

## ✨ 功能特色

| | |
|---|---|
| 🔄 **Turn 级自动续跑** | 在 dsh-llm 自身的 step 级重试**耗尽之后**介入 —— 已经失败的那一轮的最后一道防线 |
| 🚦 **认得真正的失败类别** | `RATE_LIMIT`（429）、`QUOTA`、`ACCOUNT_QUOTA`、`EMPTY_RESPONSE` 为内置，始终启用 |
| ➕ **自定义错误码** | 在设置页添加任意错误码；采用**递归搜索**，藏在错误 `cause` 里的服务商报文也能命中 |
| 🎛 **输入区快捷开关** | 输入框底部的一枚胶囊按钮，点一下即可开关，不用离开对话 |
| ⚙️ **独立设置页** | 侧边栏「设置 → **Auto-Continue**」；走 DSH 官方 slot API 渲染，**不再抓取 DOM** |
| 🧮 **每会话独立计数** | 某个会话连续失败到上限就自己停下，不影响其它会话；任何一轮成功即清零 |
| ✋ **手动发消息即清零** | 你自己发一条消息，所有计数归零（自动 continue **不算**干预） |
| ⏱️ **随机 1–2 秒退避** | 刻意**不随次数增长**：用来熬过滑动的限流窗口，而不是越退越远 |
| 💾 **设置持久化** | 保存在 `~/.dsh/dsh-auto-continue.json` |

## 🚀 工作流程

```
LLM 返回 429 / 配额耗尽 / 空响应
  ↓
dsh-llm 在当前 step 内自己重试（内置：5 次，500ms → 10s 退避）
  ↓
重试耗尽 → 该轮以  reason.kind === 'error'  或  'max-tokens'  结束
  ↓
★ 本插件介入
  ↓
随机等待 1~2 秒 → 发送 "continue" → 新的一轮启动 ✅
  ↓
……如果又失败，重复上述过程，直到连续失败上限
  ↓
任何一轮正常结束 → 计数归零 🎉
  ↓
达到上限 → 停止，等待你手动介入
```

内置错误码是**精确匹配** `LlmFailure.code` 的 —— DSH 的官方约定是「按 code 路由，永远不要解析 message」。
你自己添加的错误码则会在**整个递归错误**里搜索，因此再奇怪的报文也能被捕获。

`SERVER`、`TIMEOUT`、`TRANSPORT` **刻意不做内置**：dsh-llm 已经在 step 内重试过它们了，
在这之上再续跑一轮等于重复叠加。

## ⚙️ 设置页

打开 **设置 → Auto-Continue**。

| 控件 | 作用 |
|---|---|
| **Enable plugin** | 主开关。关闭后隐藏输入区胶囊按钮，并停止一切自动续跑 |
| **Show the quick switch in the composer** | 只隐藏胶囊按钮，自动续跑照常工作 |
| **Consecutive failure limit** | 1–100（默认 20）。任何一轮成功都会把计数清零 |
| **Additional auto-continue error codes** | 逗号或换行分隔；多词的服务商报文会**整条保留**，不会被拆散 |

## 🧩 配置（可选）

在 `cordis.patch.yml` 或 profile 配置中声明覆盖项：

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    maxRetries: 20                 # 连续失败多少次后放弃
    continueMessage: "continue"    # 续跑时发送的文本
    errorCodes: ["invalid_request_error"]
```

## 🏗 架构

标准的 DSH 双端插件（Cordis 驱动）：

```
dsh-auto-continue/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 层补丁：插入插件行
├── lib/
│   ├── index.js          # 宿主端：错误拦截、退避、continue、HTTP 路由
│   └── client.js         # 浏览器端：输入区开关 + 设置分区（React，走 slots）
├── test/run.mjs          # 验证脚本（52 条断言，覆盖两端）
├── LICENSE               # MIT
└── README.md
```

**宿主端**（`lib/index.js`）

| 接入点 | 用途 |
|---|---|
| `ctx.inject(["webServer"])` | 在 `/api/dsh-auto-continue/*` 下注册 6 个 HTTP 路由供浏览器端使用 |
| `ctx.on("session/event", …)` | 监听 `turn/end`，发现可重试原因后调度 continue |
| `ctx.agents.get(id).followup(…)` | 发送 `continue` 用户消息 |

**浏览器端**（`lib/client.js`）—— 通过 DSH 官方 slot API（`@deepseek-ai/dsh-client-ui-slots`）
注册 React 组件，不再抓取 CSS-module 哈希：

- `conversation.composer.bar` → 输入区的快捷开关胶囊
- `settings.section` → 「设置 → **Auto-Continue**」页面
- 每 2 秒轮询 `GET /api/dsh-auto-continue/state`，标签页隐藏时自动暂停
- 每处注册都包了保护，单点失败**不会**让整个 slot 变空

## 🔒 权限

- **除设置外不碰文件系统** —— 只写 `~/.dsh/dsh-auto-continue.json`（< 1 KB）
- **不读取你的 API Key** —— 完全复用 DSH 自己的 agent / `followup` 通道
- **不外发任何网络请求** —— 所有 HTTP 路由走 DSH 内置 webServer（仅本机回环）

从旧的 `dsh-auto-continue-429` 升级？插件会**读取一次** `~/.dsh/auto-continue-429.json`，
把你原有的失败上限与错误码列表迁移到新文件，不会丢配置。

## 🐛 调试

宿主端日志（DSH stdout）：

```
[Auto-Continue] Session sess_xxx failure 3/20, sending continue in 1862ms
[Auto-Continue] Sent continue to session sess_xxx
[Auto-Continue] Consecutive failure limit of 20 reached, stopping automatic continue
```

设置文件：

```
~/.dsh/dsh-auto-continue.json
→ {"enabled": true, "quickOn": true, "buttonHidden": false, "maxRetries": 20, "errorCodes": [...]}
```

## ☕ 支持

如果这个插件对你有帮助，欢迎在 **[ko-fi.com/spix18](https://ko-fi.com/spix18)** 请我喝杯咖啡。

## 📜 开源协议

**MIT** © 2026
