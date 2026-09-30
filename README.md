# dsh-auto-continue-429

> DeepSeek Harness（DSH）插件：遇到 429 限流 / 配额耗尽自动 continue 恢复对话，20 次连续失败才停，成功一次即清零。

---

## ✨ 功能特色

| 能力 | 说明 |
|---|---|
| 🔄 自动 Continue | dsh-llm-retry 的 step 级重试耗尽后，**自动发送 continue** 开启新 turn |
| 🚦 识别 429 与配额耗尽 | 监听 `RATE_LIMIT`（429）与 `QUOTA`（`insufficient_quota` 等）两类错误码 |
| ➕ 自定义错误码 | 设置页可随时添加额外错误码；默认包含 `invalid_request_error`，可处理 thinking mode 缺失 `reasoning_content` 的 400 错误 |
| 🎛 对话框底部开关 | 输入区底部「开/关」滑动开关，**点击即切换**，无需去设置页 |
| ⚙ 设置页主开关 | 「启用插件」主开关：停用后插件整体失效，**对话框不再显示开关按钮**（两开关互不联动） |
| 🧮 连续失败计数 | **每会话独立计数**：连续失败 20 次只停止该会话，任何一次 turn 正常结束即清零，互不影响 |
| ✋ 手动干预即清零 | 你**主动发送任意消息**后，所有会话积攒的失败计数**全部归零**（自动 continue 不算干预） |
| ⏱️ 随机 1~2 秒退避 | 每次 429 后随机等待 1~2 秒发送 continue（不随重试次数增长） |
| 🤫 无计数显示 | 开关条**不显示当前失败次数**；达到上限该会话自动停止，再发一条消息即清零 |
| 💾 设置持久化 | 开关状态/隐藏状态保存在 `~/.dsh/auto-continue-429.json` |

UI 交互示例：
```
┌─────────────────────────────────────────┐
│                                         │
│   对话内容                               │
│                                         │
│  [🟢429] [开]      ← 对话框底部开关条    │
│  （设置页停用插件后，此开关条自动隐藏）     │
└─────────────────────────────────────────┘
```

---

## 📦 安装

### 方式 1：已发布到 npm（发布后）

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-auto-continue-429
```

### 方式 2：从 GitHub 安装

```bash
dsh plugin --profile web add github:haochi72/dsh-auto-continue-429
```

### 方式 3：本地开发链接

```bash
cd ~/.dsh/profiles/web
pnpm link /path/to/dsh-auto-continue-429
```

然后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组末尾加上：

```json
"dsh-auto-continue-429"
```

**重启 DSH Desktop** 生效。

---

## 🚀 使用

### 1. 确认加载成功

重启 DSH 后在**对话框输入区底部**，应该出现一个胶囊形的 **「429」开关条**（绿色=已开启）。

### 2. 控制开关

| 操作 | 效果 |
|---|---|
| 点击对话框底部的开关条 | 切换**快捷开关**（`quickOn`），绿色=开，灰色=关 |
| 设置页 → 429 自动 Continue 卡片 →「启用插件」 | 切换**主开关**（`enabled`），与对话框快捷开关**互不联动** |
| 在设置页停用插件 | 对话框底部的开关条**自动隐藏**；重新启用后恢复显示 |
| 设置页 →「连续失败上限」 | 自定义失败多少轮后停止自动 continue（1-100） |
| 设置页 → “Additional auto-continue error codes” | 用逗号或换行添加错误码；`RATE_LIMIT` 与 `QUOTA` 始终启用 |

### 3. 遇到 429 / 配额耗尽时的行为

```
LLM 返回 429 或配额耗尽(insufficient_quota)
  ↓
dsh-llm-retry 在当前 step 内重试 2 次（内置）
  ↓
重试耗尽 → turn 以 error(RATE_LIMIT / QUOTA) 结束
  ↓
★ 本插件介入
  ↓
等 1~2 秒（随机）→ 发送 "continue" → 新 turn 启动 ✅
  ↓
（如果又 429）
  ↓
等 1~2 秒（随机）→ 发送 "continue" → …（重复到第 20 次）
  ↓
如果某次 turn 正常结束（reason.kind ≠ error）→ 计数归零 🎉
  ↓
连续 20 次全失败 → 停止，等待手动介入
```

---

## ⚙️ 配置（可选）

插件提供以下 Schema 配置项（在 cordis.patch.yml 或 profile 配置中声明）：

```yaml
- id: auto-continue-429
  name: dsh-auto-continue-429
  config:
    maxRetries: 20          # 连续失败最大次数（默认20）
    continueMessage: "continue"  # 发送的 continue 消息文本
```

---

## 🧩 架构

本插件是 DSH 标准的双端插件（Cordis 驱动）：

```
dsh-auto-continue-429/
├── package.json          # dsh.bundle.patch 声明 + dsh.client 声明
├── cordis.patch.yml      # bundle 层补丁：插入插件行
├── lib/
│   ├── index.js          # 宿主端：错误拦截 + 退避 + continue + HTTP 路由
│   └── client.js         # 客户端：对话框底部开关条 + 设置页卡片
├── LICENSE               # MIT
└── README.md
```

### 宿主端接入点

| 接入点 | 说明 |
|---|---|
| `ctx.inject(["webServer"])` | 注册 5 个 HTTP 路由供客户端轮询与控制 |
| `ctx.on("session/event", …)` | 监听 `turn/end`，检测 `RATE_LIMIT` / `QUOTA` 错误码后调度 continue（全局监听，覆盖所有会话） |
| `ctx.agents.get(sessionId).followup(…)` | 发送 continue 用户消息 |

### 客户端接入点

纯 DOM 注入（不依赖 React），通过 HTTP `fetch` 与宿主端通信：

- 启动时在对话框输入区底部创建「开/关」开关条
- 每 2 秒 `GET /api/auto-continue-429/state` 同步状态
- `POST /toggle-quick` 切换对话框快捷开关、`POST /toggle` 切换设置页主开关、`POST /set-max-retries` 保存失败上限
- `MutationObserver` 监听设置页 DOM 自动注入设置卡片；输入区被 SPA 重渲染时自动重新挂载开关条

---

## 🔒 权限

- **不访问文件系统**：仅 `~/.dsh/auto-continue-429.json` 保存开关状态（<1KB）
- **不读取 API Key**：完全复用 DSH 内置的 agent/followup 通道
- **不外发任何网络请求**：所有 HTTP 路由走 DSH 内置 webServer（localhost 回环）

---

## 🐛 调试

宿主端日志（DSH stdout）：

```
[auto-continue-429] 会话 sess_xxx 连续失败第 3/20 次，2000ms 后自动 continue
[auto-continue-429] 已发送 continue 到会话 sess_xxx
[auto-continue-429] 已达连续失败上限 20 次，停止自动 continue
```
设置文件路径：

```
~/.dsh/auto-continue-429.json
→ {"enabled": true, "quickOn": true, "buttonHidden": false, "maxRetries": 20}
```

---

## 📜 开源协议

**MIT** © 2026
