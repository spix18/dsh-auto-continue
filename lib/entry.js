/**
 * dsh-auto-continue-429 — 双端通用入口。
 *
 * 设计意图：
 * 本包被 profile.json 的 bundles 列表同时暴露给「宿主端 cordis loader（Node）」
 * 和「客户端 cordis loader（浏览器）」。两者都要求 `exports["."]` 指向的
 * ESM 模块必须导出合法的 cordis 插件签名（apply / inject / name）。
 *
 * 但是真正的宿主端实现 `./index.js` 顶部直接 `import "node:fs/path/os/crypto"`，
 * 浏览器里解析会失败 → 导致最终 exports 为 undefined → 触发用户报告的错误
 * "invalid plugin, expect function or object with an apply method, received undefined"。
 *
 * DSH 的自定义 resolver 目前不支持 package.json conditional exports 里的
 * `browser` / `workerd` 等条件，所以本文件使用「动态 import + 运行时回退」
 * 的写法：在两端都能作为合法的 ESM top-level parse 通过，运行时再决定实际
 * 导出哪一边。
 *
 *   - Node（宿主端）：`await import('./index.js')` 成功，把 apply/inject/name
 *     原样再导出，保证 DSH 启动时的 HTTP 路由、状态管理、RATE_LIMIT 拦截全生效。
 *   - 浏览器（客户端 cordis loader）：`await import('./index.js')` 会因为
 *     node builtins 无法解析而抛错，被 catch 住后回退到一个「零副作用、
 *     拥有合法 cordis 插件签名的空对象」。真正的客户端 UI 代码（悬浮按钮、
 *     设置页卡片）由 DSH 的 client.inject 机制通过 `exports["./client"]`
 *     把 `./client.js` 注入页面，再由 window.__ModuleLoader__.load 注册执行，
 *     不走这条 cordis 路径，所以互不影响。
 */

const host = await (async () => {
  try {
    return await import("./index.js");
  } catch {
    return null;
  }
})();

const FALLBACK = {
  name: "Auto-Continue",
  inject: [],
  apply: function apply() {
    // 浏览器端 cordis loader 只需要一个合法的 apply 函数即可，
    // 真正的客户端副作用在 client.js / __ModuleLoader__.load 里执行。
  },
};

export const name = host?.name ?? FALLBACK.name;
export const inject = host?.inject ?? FALLBACK.inject;
export const apply = host?.apply ?? FALLBACK.apply;
export default apply;
