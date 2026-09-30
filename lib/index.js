/**
 * dsh-auto-continue-429 — 单文件双端入口（宿主端 Node + 客户端浏览器打包期通过）
 *
 * ⚠️ 不要在本文件的 ESM 顶层（模块级）写任何 `import "node:..."`。
 *    DSH 的客户端 bundler 会把本模块也打到浏览器侧的 cordis loader 里，
 *    顶层出现 node builtins 会导致 bundler 打包失败、最终 export 出来的
 *    plugin 对象变成 undefined，触发"invalid plugin…received undefined"错误。
 *
 * 正确策略：
 *   - Node builtins（fs/path/os/crypto）统一通过「lazy dynamic import」在
 *     `apply(ctx, config)` 第一次被调用后再获取（apply 是 async，返回 Promise
 *     对 cordis 是合法的）。
 *   - 模块顶层只有 createUserMessage、name、inject、CONFIG_DEFAULTS 等纯数据，
 *     确保：
 *       1) 客户端 bundler 能顺利 parse + bundle
 *       2) cordis loader 永远能拿到 `typeof apply === "function"`
 *           （不再 received undefined）
 *       3) Node.js 宿主端执行时，apply 里会再懒加载 Node 内置模块。
 */

// ── createUserMessage 内联实现（浏览器/Node 双端都可运行）─────────────
// 不再依赖 @deepseek-ai/dsh-llm，也不依赖顶层 import。
// Node 22+ 和所有现代浏览器都自带 globalThis.crypto.randomUUID()。
function _deepFreeze(obj) {
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t !== "object" && t !== "function") return obj;
  if (Object.isFrozen(obj)) return obj;
  const propNames = Object.getOwnPropertyNames(obj);
  for (const k of propNames) _deepFreeze(obj[k]);
  return Object.freeze(obj);
}

export function createUserMessage(input) {
  const clone = (typeof structuredClone === "function")
    ? structuredClone(input)
    : JSON.parse(JSON.stringify(input));
  const msg = {
    ...clone,
    role: "user",
    id: globalThis.crypto.randomUUID(),
  };
  return _deepFreeze(msg);
}

const name = "Auto-Continue";
const PLUGIN_LABEL = "Auto-Continue";
const inject = ["agents"];

const CONFIG_DEFAULTS = {
  maxRetries: 20,
  continueMessage: "continue",
  errorCodes: ["invalid_request_error"],
};

const DEFAULT_MAX_RETRIES = 20;
const MIN_MAX_RETRIES = 1;
const MAX_MAX_RETRIES = 100;
// DSH 适配器把 provider 错误归为稳定 code：
//   - "RATE_LIMIT"  429 请求频率受限（dsh-llm 的 LlmError.failure.code）
//   - "QUOTA"       配额/余额耗尽（OpenAI 系 "insufficient_quota" 等被
//                   isQuotaExceededError 归一化为 QUOTA_EXCEEDED_CODE）
// 两类都属于"临时无法完成、可稍后继续"的失败，插件都应自动 continue。
const RETRYABLE_ERROR_CODES = new Set(["RATE_LIMIT", "QUOTA"]);
const RETRYABLE_TURN_REASONS = new Set(["max-tokens"]);
const DEFAULT_CUSTOM_ERROR_CODES = ["invalid_request_error"];
const MAX_CUSTOM_ERROR_CODES = 50;
// 两个独立的开关：
//   - `enabled`  设置页主开关（停用后插件整体失效，对话框里的开关按钮也会隐藏）
//   - `quickOn`  对话框底部的快捷开关（与设置页主开关「不联动」，各自独立）
// 自动 continue 仅在 `enabled && quickOn` 同时为真时才会触发。
let settings = {
  enabled: true,
  quickOn: true,
  buttonHidden: false,
  maxRetries: DEFAULT_MAX_RETRIES,
  errorCodes: [...DEFAULT_CUSTOM_ERROR_CODES],
};
let settingsFile = null;
let settingsLoaded = false;

// ── Node.js builtins 的 lazy loader（只在宿主端 apply 被调用时触发）─────
/**
 * @type {Promise<{
 *   isNode: true,
 *   fs: typeof import("node:fs"),
 *   path: typeof import("node:path"),
 *   os: typeof import("node:os"),
 * }> | Promise<{isNode:false}>}
 */
let _builtinsPromise = null;
function getBuiltins() {
  if (_builtinsPromise) return _builtinsPromise;
  _builtinsPromise = (async () => {
    try {
      const [fs, path, os] = await Promise.all([
        import("node:fs"),
        import("node:path"),
        import("node:os"),
      ]);
      return { isNode: true, fs, path, os };
    } catch {
      return { isNode: false };
    }
  })();
  return _builtinsPromise;
}

// settingsFile / loadSettings / saveSettings 在拿到 builtins 后才能使用
function ensureNodeRuntimeOrThrow(b) {
  if (!b.isNode) throw new Error("not running on Node.js host runtime");
}
function ensureSettingsReady(b) {
  ensureNodeRuntimeOrThrow(b);
  if (!settingsFile) {
    // 注意：第一次调用时 settingsFile、settingsLoaded 都在同一个微任务里初始化
    settingsFile = b.path.join(b.os.homedir(), ".dsh", "auto-continue-429.json");
  }
  if (!settingsLoaded) {
    try {
      if (b.fs.existsSync(settingsFile)) {
        const data = JSON.parse(b.fs.readFileSync(settingsFile, "utf8"));
        settings = { ...settings, ...data };
        const n = Number(settings.maxRetries);
        if (!Number.isFinite(n) || n < MIN_MAX_RETRIES || n > MAX_MAX_RETRIES) {
          settings.maxRetries = DEFAULT_MAX_RETRIES;
        } else {
          settings.maxRetries = Math.floor(n);
        }
        settings.errorCodes = normalizeErrorCodes(settings.errorCodes);
      }
    } catch {
      // 读取失败，使用默认值
    }
    settingsLoaded = true;
  }
}

function normalizeErrorCodes(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\s,]+/) : DEFAULT_CUSTOM_ERROR_CODES);
  return [...new Set(source
    .map((code) => String(code).trim().toLowerCase())
    .filter((code) => code && code.length <= 100))]
    .slice(0, MAX_CUSTOM_ERROR_CODES);
}

function collectErrorStrings(value, out = new Set(), seen = new Set(), depth = 0) {
  if (value == null || depth > 6) return out;
  if (typeof value === "string" || typeof value === "number") {
    out.add(String(value).toLowerCase());
    return out;
  }
  if (typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Error) {
    if (value.name) out.add(String(value.name).toLowerCase());
    if (value.message) out.add(String(value.message).toLowerCase());
    if (value.cause) collectErrorStrings(value.cause, out, seen, depth + 1);
  }
  for (const key of Object.keys(value)) {
    out.add(String(key).toLowerCase());
    collectErrorStrings(value[key], out, seen, depth + 1);
  }
  return out;
}

function isRetryableError(error) {
  if (!error) return false;
  if (RETRYABLE_ERROR_CODES.has(error.code)) return true;
  const configured = normalizeErrorCodes(settings.errorCodes);
  if (!configured.length) return false;
  const haystack = [...collectErrorStrings(error)].join("\n");
  return configured.some((code) => haystack.includes(code));
}
function saveSettingsNow(b) {
  ensureNodeRuntimeOrThrow(b);
  ensureSettingsReady(b);
  try {
    const dir = b.path.join(b.os.homedir(), ".dsh");
    if (!b.fs.existsSync(dir)) b.fs.mkdirSync(dir, { recursive: true });
    b.fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    // 写入失败，忽略
  }
}

// ── 退避算法 ───────────────────────────────────────────────────────────
// 每次重试延迟 1~2 秒随机，不随重试次数增长
function randomDelayMs() {
  return 1000 + Math.random() * 1000;
}

// ── apply ──────────────────────────────────────────────────────────────
// Cordis 接受 async apply；我们用它做 Node builtins 的延迟加载。
async function apply(ctx, config = {}) {
  const b = await getBuiltins();

  // 在浏览器侧（/ 或任何非 Node 运行时）：只是一个合法的空 cordis 插件，
  // 不做任何事（真正的客户端 UI 由 dsh.client.inject 通过 client.js 注入）。
  if (!b.isNode) return;

  // ===== 宿主端（Node）真实业务逻辑 =====
  ensureSettingsReady(b);

  const continueMessage = config.continueMessage ?? CONFIG_DEFAULTS.continueMessage;
  if (!Array.isArray(settings.errorCodes)) {
    settings.errorCodes = normalizeErrorCodes(config.errorCodes ?? CONFIG_DEFAULTS.errorCodes);
  }

  // 兼容 schema 级别的 maxRetries 初始值（若配置了且合法）
  const schemaMax = Number(config.maxRetries);
  if (
    Number.isFinite(schemaMax) &&
    schemaMax >= MIN_MAX_RETRIES &&
    schemaMax <= MAX_MAX_RETRIES &&
    settings.maxRetries === DEFAULT_MAX_RETRIES
  ) {
    settings.maxRetries = Math.floor(schemaMax);
    saveSettingsNow(b);
  }
  function getMaxRetries() { return settings.maxRetries; }

  const sessionState = new Map();

  // ── HTTP 路由（供客户端读取/切换状态）────────────────────────────────
  ctx.inject(["webServer"], (wctx) => {
    wctx.effect(() => {
      const routes = [
        {
          kind: "exact",
          path: "/api/auto-continue-429/state",
          handler: async (req, res) => {
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.writeHead(405); res.end();
              return;
            }
            let retryCount = 0;
            const retryCounts = {};
            for (const [id, s] of sessionState) {
              retryCounts[id] = s.retryCount;
              retryCount = Math.max(retryCount, s.retryCount);
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
              enabled: settings.enabled,
              quickOn: settings.quickOn,
              buttonHidden: settings.buttonHidden,
              retryCount,
              retryCounts,
              maxRetries: getMaxRetries(),
              errorCodes: settings.errorCodes,
            }));
          },
        },
        {
          kind: "exact",
          path: "/api/auto-continue-429/toggle",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            settings.enabled = !settings.enabled;
            saveSettingsNow(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ enabled: settings.enabled, maxRetries: getMaxRetries() }));
          },
        },
        {
          kind: "exact",
          path: "/api/auto-continue-429/toggle-quick",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            settings.quickOn = !settings.quickOn;
            saveSettingsNow(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ quickOn: settings.quickOn, enabled: settings.enabled }));
          },
        },
        {
          kind: "exact",
          path: "/api/auto-continue-429/hide-button",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settings.buttonHidden = body.hidden === true;
              saveSettingsNow(b);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ buttonHidden: settings.buttonHidden, maxRetries: getMaxRetries() }));
            } catch {
              res.writeHead(400); res.end("invalid json");
            }
          },
        },
        {
          kind: "exact",
          path: "/api/auto-continue-429/set-max-retries",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const n = Number(body.maxRetries);
              if (
                !Number.isFinite(n) ||
                n < MIN_MAX_RETRIES ||
                n > MAX_MAX_RETRIES
              ) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({
                  ok: false,
                  error: `maxRetries must be an integer from ${MIN_MAX_RETRIES} to ${MAX_MAX_RETRIES}`,
                  maxRetries: getMaxRetries(),
                }));
                return;
              }
              settings.maxRetries = Math.floor(n);
              saveSettingsNow(b);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, maxRetries: settings.maxRetries }));
            } catch {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "invalid json", maxRetries: getMaxRetries() }));
            }
          },
        },
        {
          kind: "exact",
          path: "/api/auto-continue-429/set-error-codes",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!Array.isArray(body.errorCodes) && typeof body.errorCodes !== "string") {
                throw new Error("errorCodes must be an array or string");
              }
              settings.errorCodes = normalizeErrorCodes(body.errorCodes);
              saveSettingsNow(b);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, errorCodes: settings.errorCodes }));
            } catch {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({
                ok: false,
                error: "Enter error codes separated by commas or new lines.",
                errorCodes: settings.errorCodes,
              }));
            }
          },
        },
      ];
      const disposers = routes.map((r) => wctx.webServer.register(r));
      return () => disposers.forEach((d) => d());
    });
  });

  // ── 会话事件监听 ──────────────────────────────────────────────────
  ctx.on("session/event", (session, event) => {
    const sessionId = session.id;

    // 用户主动发送消息（非本插件自动 continue）：所有会话的失败计数归零。
    // 本插件 followup 的 continue 消息带 source: {kind:"plugin",
    // plugin:"Auto-Continue"}，据此区分；同时取消当前会话待发送的
    // continue，避免用户已手动输入后再重复自动继续。
    if (event.type === "user/message") {
      const msg = event.data || {};
      const src = msg.source || {};
      if (src.kind === "plugin" && src.plugin === PLUGIN_LABEL) return;
      for (const s of sessionState.values()) s.retryCount = 0;
      const cur = sessionState.get(sessionId);
      if (cur && cur.pendingTimer) {
        clearTimeout(cur.pendingTimer);
        cur.pendingTimer = null;
      }
      return;
    }

    if (event.type === "turn/end") {
      const reason = event.data?.reason;
      // 正常完成（reason 为空）或非错误/中止的 turn：重置连续失败计数
      if (
        !reason ||
        (
          reason.kind !== "error" &&
          reason.kind !== "aborted" &&
          !RETRYABLE_TURN_REASONS.has(reason.kind)
        )
      ) {
        const s = sessionState.get(sessionId);
        if (s) s.retryCount = 0;
        return;
      }
    }

    if (event.type !== "turn/end") return;
    const reason = event.data?.reason;
    if (!reason) return;
    const retryableTurnReason = RETRYABLE_TURN_REASONS.has(reason.kind);
    const retryableError = reason.kind === "error" && isRetryableError(reason.error);
    if (!retryableTurnReason && !retryableError) return;

    if (!settings.enabled || !settings.quickOn) {
      console.info("[Auto-Continue] Disabled by the master or quick switch, skipping");
      return;
    }

    let s = sessionState.get(sessionId);
    if (!s) {
      s = { retryCount: 0, pendingTimer: null };
      sessionState.set(sessionId, s);
    }

    if (s.retryCount >= getMaxRetries()) {
      console.warn(
        `[Auto-Continue] Consecutive failure limit of ${getMaxRetries()} reached, stopping automatic continue`
      );
      return;
    }

    s.retryCount++;
    const current = s.retryCount;

    const delay = randomDelayMs();

    console.info(
      `[Auto-Continue] Session ${sessionId} failure ${current}/${getMaxRetries()}, sending continue in ${Math.round(delay)}ms`
    );

    s.pendingTimer = setTimeout(() => {
      s.pendingTimer = null;
      try {
        const agent = ctx.agents.get(sessionId);
        if (!agent) {
          console.warn(`[Auto-Continue] No agent found for session ${sessionId}`);
          return;
        }
        agent.followup(
          createUserMessage({
            content: [{ type: "text", text: continueMessage }],
            source: { kind: "plugin", plugin: PLUGIN_LABEL },
          })
        );
        console.info(`[Auto-Continue] Sent continue to session ${sessionId}`);
      } catch (e) {
        console.error(`[Auto-Continue] Failed to send continue: ${e.message}`);
      }
    }, delay);
  });

  // ── 会话销毁：清理计数与待发送的 continue ────────────────────────
  // 每个会话独立计数（sessionState 按 id 隔离），已删除的会话不再
  // 参与 /state 的最大值计算，也不残留 pendingTimer 造成误发 continue。
  ctx.on("session/disposed", (session) => {
    const s = sessionState.get(session.id);
    if (!s) return;
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    sessionState.delete(session.id);
  });

  // ── 清理 ──────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    for (const s of sessionState.values()) {
      if (s.pendingTimer) clearTimeout(s.pendingTimer);
    }
    sessionState.clear();
  });
}

// 保证 module.exports/apply/name/inject 都真实存在，
// 任何端（Node 或浏览器）的 cordis loader 都不会再报"received undefined"。
// 注意：必须既有 named exports 又有 default export，
// 因为不同的 DSH loader 路径（Cordis 原生 vs ESM import vs bundler）
// 对两种形式的接受度不同。
export { apply, inject, name };
export default { apply, inject, name };
