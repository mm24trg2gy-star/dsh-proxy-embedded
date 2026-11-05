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

function snapshot() {
  return {
    phase: state.phase,
    link: state.link,
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

  /**
   * Full start: import -> start core -> install route.
   * @param {{ link: string, port?: number, kernelPath?: string, noProxy?: string }} input
   */
  async function start(input) {
    const link = String(input.link || "").trim();
    if (link === "") return { ok: false, reason: "没有订阅链接" };
    const port = Number.isFinite(input.port) ? input.port : DEFAULT_PORT;
    const kernelPath = typeof input.kernelPath === "string" && input.kernelPath.trim() !== "" ? input.kernelPath.trim() : undefined;

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

    // swap core settings for this run
    core.stop();
    core = createCore({ kernelPath: kernelPath ?? core.kernelPath });
    const started = await core.start({ port, yaml: imported.yaml });
    if (started.ok !== true) {
      state.phase = "error";
      state.message = started.reason;
      touch();
      return { ok: false, reason: started.reason };
    }

    // install the route for the host process
    const support = await routeSupportRef();
    if (support.ok !== true) {
      state.phase = "core-only";
      state.message = "内核已起，但无法安装代理路由：" + support.reason;
      state.url = "http://127.0.0.1:" + started.port;
      state.port = started.port;
      touch();
      return { ok: false, reason: support.reason };
    }
    const installed = await installRoute(support.harness, "http://127.0.0.1:" + started.port, input.noProxy, log);
    if (installed.ok !== true) {
      state.phase = "core-only";
      state.message = "内核已起，但路由未生效：" + installed.reason;
      state.url = "http://127.0.0.1:" + started.port;
      state.port = started.port;
      touch();
      return { ok: false, reason: installed.reason };
    }
    release = installed.release;

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
  async function stop() {
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
  let hostname;
  try { hostname = new URL("http://" + host).hostname; } catch { return false; }
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!loopback) return false;
  if (headers["sec-fetch-site"] === "cross-site") return false;
  const origin = headers.origin;
  if (typeof origin !== "string") return true;
  try { return new URL(origin).hostname === hostname; } catch { return false; }
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

/** Build the API handler for the settings page / AI tooling. */
function createApiHandler(engine, log) {
  return async function handler(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: "forbidden" } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed" } });
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
        sendJson(res, 200, { ok: true, value: engine.status() });
        return;
      }
      if (action === "start") {
        const config = await readConfig();
        const link = typeof body.link === "string" && body.link.trim() !== "" ? body.link.trim() : config.link;
        if (typeof link !== "string" || link.trim() === "") {
          sendJson(res, 400, { ok: false, error: { code: "no-link", message: "缺少订阅链接（body.link 或 config.json 的 link）" } });
          return;
        }
        if (typeof body.link === "string" && body.link.trim() !== "") await saveConfig({ link: body.link.trim() });
        const result = await engine.start({
          link,
          port: Number.isFinite(body.port) ? body.port : config.port,
          kernelPath: typeof body.kernelPath === "string" ? body.kernelPath : config.kernelPath,
          noProxy: typeof body.noProxy === "string" ? body.noProxy : config.noProxy,
        });
        sendJson(res, result.ok ? 200 : 500, { ok: result.ok, value: engine.status(), error: result.ok ? undefined : { code: "start-failed", message: result.reason } });
        return;
      }
      if (action === "stop") {
        await engine.stop();
        sendJson(res, 200, { ok: true, value: engine.status() });
        return;
      }
      if (action === "save") {
        const merged = await saveConfig({
          link: typeof body.link === "string" ? body.link : undefined,
          port: Number.isFinite(body.port) ? body.port : undefined,
          kernelPath: typeof body.kernelPath === "string" ? body.kernelPath : undefined,
          noProxy: typeof body.noProxy === "string" ? body.noProxy : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        });
        sendJson(res, 200, { ok: true, value: merged });
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
          const handler = createApiHandler(engine, log);
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

/** Awaited start used by tooling/tests. */
export async function start(ctx, config) {
  const log = makeLogger(ctx);
  const engine = createEngine(log);
  const result = await engine.start(config);
  return { ...result, status: engine.status, stop: engine.stop };
}
