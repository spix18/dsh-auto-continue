/**
 * dsh-auto-continue-429 — 浏览器（客户端 cordis loader）入口。
 *
 * 背景：
 * dsh-auto-continue-429 作为 bundle 写入 profile.json 的 bundles 列表后，
 * DSH 的客户端 cordis loader 也会按 `exports["."]` 尝试把本包当作一个
 * client cordis plugin 来 apply（并调用它的 apply() 方法）。
 * 但真正的业务实现只在两端分别存在：
 *   - 宿主端（Node）：`../lib/index.js`（含 node:fs/path 等内置模块）
 *   - 客户端（页面 script）：`../lib/client.js`，通过 __ModuleLoader__.load 注册
 * 因此，本文件专门为 `exports[.].browser` 条件提供一个**最轻量、零副作用**的
 * cordis 插件签名，使客户端 cordis loader 能成功 resolve 并 apply，
 * 不会再报 "invalid plugin, expect ... apply method, received undefined"。
 */

const name = "Auto-Continue";
const inject = [];
function apply() {
  /* 真正的客户端逻辑在 client.js（通过 dsh client.inject 机制注入），
     这里只需让 cordis plugin loader 拿到一个合法的 apply 函数即可。 */
}

export { name, inject, apply };
export default apply;
