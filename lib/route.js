/**
 * Install / release the process-wide proxy route that `web_fetch` consults.
 *
 * `dsh-web-fetch-http` asks `@deepseek-ai/dsh-http-proxy` for `proxyRouteFor()`;
 * only a `proxied: true` route makes it tunnel through the proxy instead of
 * resolving the origin locally and rejecting fake-IP answers.
 *
 * @module dsh-proxy-embedded/route
 */
import { loadHarness } from "./harness.js";

const PROBE_URL = "https://example.com/";

/** A URL whose public origin behaves the same for every route decision. */
function probeUrl() {
  return new URL(PROBE_URL);
}

/**
 * Prepare the harness handle.
 * @returns {Promise<{ ok: true, harness: object } | { ok: false, reason: string }>}
 */
export async function loadRouteSupport() {
  const harness = await loadHarness(process.env);
  if (harness.ok !== true) return { ok: false, reason: harness.reason };
  return { ok: true, harness };
}

/**
 * Read the route the host currently has installed.
 * @param {object} harness
 */
export function currentRoute(harness) {
  try {
    const route = harness.proxy.proxyRouteFor(probeUrl());
    if (route !== undefined && route.proxied === true) {
      return { proxied: true, url: route.proxy };
    }
    return { proxied: false };
  } catch {
    return { proxied: false };
  }
}

/**
 * Install a proxied route pointing at `proxyUrl`.
 *
 * @param {object} harness - handle from loadRouteSupport()
 * @param {string} proxyUrl - e.g. http://127.0.0.1:7899
 * @param {string} [noProxy] - comma-separated direct-connect suffixes
 * @param {(level: string, message: string) => void} [log]
 * @returns {Promise<{ ok: true, release: () => Promise<void>, url: string } | { ok: false, reason: string }>}
 */
export async function installRoute(harness, proxyUrl, noProxy, log = () => {}) {
  const values = { http_proxy: proxyUrl, https_proxy: proxyUrl };
  const bypass = [];
  if (typeof noProxy === "string" && noProxy.trim() !== "") bypass.push(noProxy.trim());
  if (typeof process.env.NO_PROXY === "string" && process.env.NO_PROXY.trim() !== "") bypass.push(process.env.NO_PROXY.trim());
  if (typeof process.env.no_proxy === "string" && process.env.no_proxy.trim() !== "") bypass.push(process.env.no_proxy.trim());
  if (bypass.length > 0) values.no_proxy = bypass.join(",");

  const environment = harness.createSnapshot([{ source: "process", values }]);
  const diagnostics = [];
  let released;
  try {
    released = await harness.proxy.installProxyFromEnvironment(environment, (message) => {
      diagnostics.push(String(message));
    });
  } catch (error) {
    return { ok: false, reason: "安装代理策略失败：" + (error && error.message ? error.message : String(error)) };
  }
  for (const message of diagnostics) log("warn", "代理策略诊断：" + message);

  const route = harness.proxy.proxyRouteFor(probeUrl());
  if (route === undefined || route.proxied !== true) {
    try { await released(); } catch { /* best effort */ }
    return { ok: false, reason: "代理策略未生效（proxyRouteFor 仍为直连）" };
  }
  return { ok: true, release: released, url: route.proxy };
}
