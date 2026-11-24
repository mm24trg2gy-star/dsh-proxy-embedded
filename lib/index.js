/**
 * dsh-proxy-embedded - host half.
 *
 * 自带/复用 mihomo 内核，吃订阅链接（Clash / base64 / sing-box / Surge），
 * 起来后给 DSH 宿主进程装一条代理路由，web_fetch 也走它。
 *
 * 第一版是「手动」：用户在设置里（或通过 /proxy-embedded/api）给链接、点启动。
 * 第二版再做「启动自动起 + 失败自动重试」。
 *
 * 配置落盘：<DSH_HOME>/proxy-embedded/config.json
 *   {
 *     "link": "https://...",        // 订阅链接或单节点链接
 *     "enabled": true,              // 启动时是否自动起
 *     "port": 7899,                 // 本地混合端口
 *     "kernelPath": "",             // 自定义 mihomo 路径，空则自动发现
 *     "noProxy": ""                 // 直连后缀
 *   }
 *
 * @module dsh-proxy-embedded
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildConfig, createCore, dataDir, DEFAULT_PORT, resolveKernel } from "./core.js";
import { convert } from "./convert.js";
import { downloadKernel } from "./kernel-download.js";
import { fetchSubscription, detectFormat } from "./subscription.js";
import { currentRoute, installRoute, loadRouteSupport } from "./route.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "proxy-embedded";

/** Host route the settings / status surface talks to. */
export const STATUS_PATH = "/proxy-embedded/api";

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** In-memory state reported by the API. */
const state = {
  phase: "idle",
  link: undefined,
  url: undefined,
  port: undefined,
  kernel: undefined,
  message: undefined,
  format: undefined,
  nodeCount: undefined,
  updatedAt: 0,
};

/** Logger that never throws. */
export function makeLogger(ctx) {
  const logger = ctx !== null && typeof ctx === "object" ? ctx.logger : undefined;
  return function log(level, message) {
    const line = "[" + name + "] " + message;
    try {
      if (logger !== undefined && logger !== null && typeof logger[level] === "function") {
        logger[level](line);
        return;
      }
      if (level === "warn" || level === "error") console.warn(line);
      else console.log(line);
    } catch {
      /* logging must never break the boot */
    }
  };
}

function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function configPath() {
  return path.join(dataDir(), "config.json");
}

/** Read the persisted config (missing file -> {}). */
export async function readConfig() {
  try {
    const text = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist a partial config merge. */
export async function saveConfig(partial) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const current = await readConfig();
  const merged = { ...current, ...(partial !== null && typeof partial === "object" ? partial : {}) };
  await writeFile(configPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function touch() {
  state.updatedAt = Date.now();
}

/** 只回传“有没有链接”和掩码，绝不把带 token 的订阅地址送到前端/API。 */
export function maskLink(link) {
  if (typeof link !== "string" || link.trim() === "") return null;
  try {
    const u = new URL(link.trim());
    // 不保留路径任何字符：路径型订阅的 token 就在 path 里，末 4 位也算泄露
    return u.protocol + "//" + u.host + "/****";
  } catch {
    return "****";
  }
}

function snapshot() {
  return {
    phase: state.phase,
    hasLink: typeof state.link === "string" && state.link.trim() !== "",
    linkMask: maskLink(state.link),
    url: state.url,
    port: state.port,
    kernel: state.kernel,
    format: state.format,
    nodeCount: state.nodeCount,
    message: state.message,
    updatedAt: state.updatedAt,
  };
}

/**
 * Create the engine: one core instance, one route owner.
 * @param {(level: string, message: string) => void} log
 */
export function createEngine(log) {
  let core = createCore({ log });
  let release;
  let routeSupport;

  async function routeSupportRef() {
    if (routeSupport === undefined) routeSupport = await loadRouteSupport();
    return routeSupport;
  }

  async function releaseRoute() {
    const fn = release;
    release = undefined;
    if (typeof fn === "function") {
      try { await fn(); } catch (error) { log("warn", "释放代理路由失败：" + describe(error)); }
    }
  }

  /**
   * Import a link: fetch -> detect -> convert -> build yaml.
   * @returns {Promise<{ ok: true, yaml: string, format: string, nodes: number } | { ok: false, reason: string }>}
   */
  async function importLink(link, port) {
    const url = String(link || "").trim();
    if (url === "") return { ok: false, reason: "链接为空" };

    // a bare single-node link can be used directly
    const single = detectFormat(url);
    if (url.includes("://") && (url.startsWith("ss://") || url.startsWith("vmess://") || url.startsWith("vless://") || url.startsWith("trojan://") || url.startsWith("hysteria2://") || url.startsWith("hy2://"))) {
      const converted = convert("base64", Buffer.from(url).toString("base64"));
      if (converted.ok !== true) return { ok: false, reason: converted.reason };
      const yaml = buildConfig({ port, proxies: converted.proxies });
      return { ok: true, yaml, format: "node", nodes: converted.proxies.length };
    }

    const fetched = await fetchSubscription(url);
    if (fetched.ok !== true) return { ok: false, reason: "抓订阅失败：" + fetched.reason };
    const format = detectFormat(fetched.text);
    if (format === "unknown") return { ok: false, reason: "无法识别订阅格式" };
    const converted = convert(format, fetched.text, { port });
    if (converted.ok !== true) return { ok: false, reason: converted.reason };
    if (converted.passthrough === true) {
      return { ok: true, yaml: converted.yaml, format, nodes: 0 };
    }
    const yaml = buildConfig({ port, proxies: converted.proxies });
    return { ok: true, yaml, format, nodes: converted.proxies.length };
  }

  /** 串行化生命周期：并发 start/stop 会抢端口、抢配置、抢路由。 */
  let chain = Promise.resolve();
  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Full start: import -> start core -> install route.
   * @param {{ link: string, port?: number, noProxy?: string }} input
   */
  function start(input) {
    return withLock(() => startInner(input || {}));
  }

  async function startInner(input) {
    const link = String(input.link || "").trim();
    if (link === "") return { ok: false, reason: "没有订阅链接" };
    const port = Number.isFinite(input.port) ? Math.trunc(input.port) : DEFAULT_PORT;
    // kernelPath 只认本地 config.json：API 不能注入，但用户自己配的仍然生效
    const saved = await readConfig();
    const kernelPath = typeof saved.kernelPath === "string" && saved.kernelPath.trim() !== "" ? saved.kernelPath.trim() : undefined;

    state.phase = "importing";
    state.message = undefined;
    touch();
    const imported = await importLink(link, port);
    if (imported.ok !== true) {
      state.phase = "error";
      state.message = imported.reason;
      touch();
      return { ok: false, reason: imported.reason };
    }

    // 先起新内核（独立端口、独立配置），成功装好路由后才替换旧的。
    // 直接把旧内核停掉再起，会让启动失败变成“旧路由指向死端口 → 整个 DSH 出站断掉”。
    const nextCore = createCore({ kernelPath: kernelPath ?? core.kernelPath, log });
    const started = await nextCore.start({ port, yaml: imported.yaml });
    if (started.ok !== true) {
      state.phase = "error";
      state.message = started.reason;
      touch();
      return { ok: false, reason: started.reason };
    }

    // install the route for the host process
    const support = await routeSupportRef();
    if (support.ok !== true) {
      nextCore.stop();
      state.phase = "core-only";
      state.message = "内核已起，但无法安装代理路由：" + support.reason;
      state.url = "http://127.0.0.1:" + started.port;
      state.port = started.port;
      touch();
      return { ok: false, reason: support.reason };
    }
    const installed = await installRoute(support.harness, "http://127.0.0.1:" + started.port, input.noProxy, log);
    if (installed.ok !== true) {
      nextCore.stop();
      state.phase = "core-only";
      state.message = "内核已起，但路由未生效：" + installed.reason;
      state.url = "http://127.0.0.1:" + started.port;
      state.port = started.port;
      touch();
      return { ok: false, reason: installed.reason };
    }

    // 新链路就绪，才停旧的
    const prevRelease = release;
    const prevCore = core;
    release = installed.release;
    core = nextCore;
    if (typeof prevRelease === "function") {
      try { await prevRelease(); } catch { /* old route already gone */ }
    }
    try { prevCore.stop(); } catch { /* old core already dead */ }

    state.phase = "ready";
    state.link = link;
    state.url = "http://127.0.0.1:" + started.port;
    state.port = started.port;
    state.kernel = started.kernel;
    state.format = imported.format;
    state.nodeCount = imported.nodes;
    state.message = undefined;
    touch();
    log("info", "代理就绪：" + state.url + "（" + imported.format + "，" + imported.nodes + " 个节点）");
    return { ok: true, url: state.url, port: started.port };
  }

  /** Stop core and release the route. */
  function stop() {
    return withLock(() => stopInner());
  }

  async function stopInner() {
    await releaseRoute();
    core.stop();
    state.phase = "stopped";
    state.url = undefined;
    state.port = undefined;
    touch();
    return { ok: true };
  }

  /** Current host route + core state, for the API. */
  function status() {
    return {
      ...snapshot(),
      route: routeSupport !== undefined && routeSupport.ok === true ? currentRoute(routeSupport.harness) : { proxied: false },
      kernelFound: resolveKernel(core.kernelPath) !== undefined,
    };
  }

  return { start, stop, status, core };
}

/** Whether one request may reach the plugin's own host route. */
function isTrustedRequest(req) {
  const headers = req !== null && typeof req === "object" && req.headers !== null && typeof req.headers === "object" ? req.headers : {};
  const host = typeof headers.host === "string" ? headers.host : "";
  if (host === "") return false;
  let url;
  try { url = new URL("http://" + host); } catch { return false; }
  const hostname = url.hostname;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!loopback) return false;
  if (headers["sec-fetch-site"] === "cross-site") return false;
  const origin = headers.origin;
  if (typeof origin !== "string") return true;
  // 必须完全同源（协议 + 主机 + 端口），只比主机名挡不住同主机的其他端口
  try { return new URL(origin).origin === url.origin; } catch { return false; }
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    let total = 0;
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { resolve(undefined); return; }
      chunks.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", function () { resolve(undefined); });
  });
}

function sendJson(res, statusCode, payload) {
  try {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {
    try { res.end(); } catch { /* caller gone */ }
  }
}

/** Minimal self-contained page: paste a link, start/stop, see status. No React. */
function renderPage() {
  return [
    "<!doctype html><html lang=\"zh\"><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>内嵌代理</title>",
    "<style>",
    "body{font:14px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;max-width:34rem;margin:7vh auto;padding:0 1.25rem;color:#1f2937}",
    "h1{font-size:1.1rem;margin:0 0 .3rem}",
    "p.hint{color:#6b7280;margin:.2rem 0 1rem}",
    "input{width:100%;padding:.55rem;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px}",
    "button{margin:.8rem .5rem 0 0;padding:.5rem 1rem;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;cursor:pointer}",
    "pre{background:#f3f4f6;padding:.75rem;border-radius:6px;overflow:auto;max-height:16rem;font-size:12px}",
    "footer{margin-top:2rem;color:#9ca3af;font-size:12px}",
    "</style>",
    "<h1>内嵌代理 · 订阅</h1>",
    "<p class=\"hint\">粘贴 Clash / V2Ray / Shadowrocket / sing-box / Surge 订阅链接，或单个节点链接。</p>",
    "<input id=\"link\" placeholder=\"https://…\" autocomplete=\"off\" spellcheck=\"false\">",
    "<div><button id=\"start\">启动</button><button id=\"stop\">停止</button><button id=\"status\">状态</button></div>",
    "<pre id=\"out\">（还没有操作）</pre>",
    "<footer>这个页面由插件在 127.0.0.1 上直接提供；链接不会回显。</footer>",
    "<script>",
    "const path = " + JSON.stringify(STATUS_PATH) + ";",
    "const out = document.getElementById('out');",
    "async function call(body){",
    "  try {",
    "    const r = await fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{}) });",
    "    const j = await r.json();",
    "    out.textContent = JSON.stringify(j.value ?? j, null, 2);",
    "  } catch (e) { out.textContent = '请求失败: ' + e.message; }",
    "}",
    "document.getElementById('start').onclick = () => call({ action:'start', link: document.getElementById('link').value });",
    "document.getElementById('stop').onclick = () => call({ action:'stop' });",
    "document.getElementById('status').onclick = () => call({ action:'status' });",
    "call({ action:'status' });",
    "</script></html>",
  ].join("");
}

/** Build the API handler for the settings page / AI tooling. */
function createApiHandler(engine, log, admit) {
  return async function handler(req, res) {
    // 第一层：让 DSH 宿主判断这个请求能不能进（拿不到准入服务就拒绝）
    const rejection = typeof admit === "function" ? admit(req) : { code: 503, message: "admission unavailable" };
    if (rejection) {
      sendJson(res, rejection.code, { ok: false, error: { code: "forbidden", message: rejection.message } });
      return;
    }
    // 第二层：插件自己的回环/来源校验
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    const method = String(req.method || "").toUpperCase();
    const url = String(req.url || "");
    if ((method === "GET" || method === "HEAD") && (url === STATUS_PATH || url === STATUS_PATH + "/" || url.startsWith(STATUS_PATH + "?"))) {
      try {
        const html = renderPage();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(html);
      } catch {
        try { res.end(); } catch { /* caller gone */ }
      }
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed" } });
      return;
    }
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "POST 必须使用 application/json" } });
      return;
    }
    const raw = await readBody(req);
    let body = {};
    if (typeof raw === "string" && raw.trim() !== "") {
      try { body = JSON.parse(raw); } catch { body = {}; }
    }
    const action = body !== null && typeof body === "object" && typeof body.action === "string" ? body.action : "status";

    try {
      if (action === "status") {
        sendJson(res, 200, { ok: true, value: await engine.status() });
        return;
      }
      if (action === "start") {
        const config = await readConfig();
        const link = typeof body.link === "string" && body.link.trim() !== "" ? body.link.trim() : config.link;
        if (typeof link !== "string" || link.trim() === "") {
          sendJson(res, 400, { ok: false, error: { code: "no-link", message: "缺少订阅链接（body.link 或 config.json 的 link）" } });
          return;
        }
        // 链接只在启动成功后保存，贴错不会覆盖上一次可用的订阅
        const result = await engine.start({
          link,
          port: Number.isFinite(body.port) ? body.port : config.port,
          // kernelPath 只从本地 config.json 读取，不接受请求注入
          noProxy: typeof body.noProxy === "string" ? body.noProxy : config.noProxy,
        });
        if (result.ok === true && typeof body.link === "string" && body.link.trim() !== "") {
          await saveConfig({ link: body.link.trim() });
        }
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, value: await engine.status(), error: result.ok ? undefined : { code: "start-failed", message: result.reason } });
        return;
      }
      if (action === "stop") {
        await engine.stop();
        sendJson(res, 200, { ok: true, value: await engine.status() });
        return;
      }
      if (action === "downloadKernel") {
        const url = typeof body.url === "string" && body.url.trim() !== "" ? body.url.trim() : undefined;
        const result = await downloadKernel({ url });
        if (result.ok === true) log("info", "内核已下载并安装：" + result.version);
        else log("warn", "下载内核失败：" + result.reason);
        sendJson(res, result.ok === true ? 200 : 500, {
          ok: result.ok === true,
          value: result.ok === true ? { version: result.version, source: result.source } : undefined,
          error: result.ok === true ? undefined : { code: "kernel-download-failed", message: result.reason },
        });
        return;
      }
      if (action === "save") {
        const merged = await saveConfig({
          link: typeof body.link === "string" ? body.link : undefined,
          port: Number.isFinite(body.port) ? body.port : undefined,
          // kernelPath 只能改本地配置文件
          noProxy: typeof body.noProxy === "string" ? body.noProxy : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        sendJson(res, 200, { ok: true, value: { ...merged, link: maskLink(merged.link) } });
        return;
      }
      sendJson(res, 400, { ok: false, error: { code: "unknown-action", message: action } });
    } catch (error) {
      log("warn", "API 处理失败：" + describe(error));
      sendJson(res, 500, { ok: false, error: { code: "internal", message: describe(error) } });
    }
  };
}

/**
 * Cordis entry point. Never throws.
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const engine = createEngine(log);

  if (ctx !== null && typeof ctx === "object" && typeof ctx.effect === "function") {
    try {
      ctx.effect(function () {
        return function () { void engine.stop(); };
      }, name + ": proxy core");
    } catch (error) {
      log("warn", "注册生命周期清理失败：" + describe(error));
    }
  }

  // boot from persisted config when enabled
  void (async function boot() {
    const saved = await readConfig();
    if (saved.enabled === false) { log("info", "配置里 enabled=false，跳过自动启动。"); return; }
    if (typeof saved.link !== "string" || saved.link.trim() === "") { log("info", "还没有订阅链接；在设置里填好后点启动。"); return; }
    const result = await engine.start({
      link: saved.link,
      port: saved.port,
      kernelPath: saved.kernelPath,
      noProxy: saved.noProxy,
    });
    if (result.ok !== true) log("warn", "自动启动失败：" + result.reason);
  })();

  if (ctx !== null && typeof ctx === "object" && typeof ctx.inject === "function") {
    try {
      ctx.inject(["webServer"], function (serverCtx) {
        try {
          const admit = makeAdmit(ctx);
          const handler = createApiHandler(engine, log, admit);
          serverCtx.effect(function () {
            return serverCtx.webServer.register({ kind: "exact", path: STATUS_PATH, handler });
          }, name + ": api route");
        } catch (error) {
          log("warn", "状态接口注册失败：" + describe(error));
        }
      });
    } catch (error) {
      log("warn", "注入 webServer 服务失败：" + describe(error));
    }
  }
  return undefined;
}

/**
 * 让 DSH 宿主来判请求能不能进（Host/Origin/连接来源），而不是只靠插件自己。
 * 拿不到 connection 服务或它自己抛错时一律拒绝：宁可多试一次，也不让别的网页调进来。
 */
export function makeAdmit(ctx) {
  return function admit(req) {
    let rejection;
    try {
      const connection = ctx !== null && typeof ctx === "object" && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      if (connection === undefined || connection === null || typeof connection.requestRejection !== "function") {
        return { code: 503, message: "DSH connection service unavailable" };
      }
      rejection = connection.requestRejection(req);
    } catch (error) {
      return { code: 503, message: "DSH connection admission failed: " + describe(error) };
    }
    if (rejection === undefined) return null; // 契约：undefined = 放行
    if (rejection === 401 || rejection === 403) return { code: rejection, message: "rejected by DSH connection admission" };
    // 认不出来的返回值不能当放行：按拒绝处理
    return { code: 503, message: "unexpected DSH admission result" };
  };
}

/** Awaited start used by tooling/tests. */
export async function start(ctx, config) {
  const log = makeLogger(ctx);
  const engine = createEngine(log);
  const result = await engine.start(config);
  return { ...result, status: engine.status, stop: engine.stop };
}
