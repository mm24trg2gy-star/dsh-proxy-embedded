/**
 * mihomo core management: locate the binary, write a config, start/stop it,
 * and probe its mixed port.
 *
 * The plugin bundles no binary by default: it reuses an existing mihomo /
 * Clash Verge build (or `bin/mihomo.exe` if the user drops one in), so the
 * repository stays small. `kernelPath` in the settings overrides discovery.
 *
 * @module dsh-proxy-embedded/core
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Default mixed port used when the user does not pick one. */
export const DEFAULT_PORT = 7899;

/** Candidate binary names inside the plugin package. */
const BUNDLED_CANDIDATES = ["bin/mihomo.exe", "bin/mihomo", "bin/verge-mihomo.exe"];

/** Candidate absolute paths on Windows (Clash Verge / Clash for Windows). */
const SYSTEM_CANDIDATES = [
  "D:\\Clash Verge\\verge-mihomo.exe",
  "C:\\Program Files\\Clash Verge\\verge-mihomo.exe",
  "C:\\Program Files (x86)\\Clash Verge\\verge-mihomo.exe",
  "D:\\Clash Verge\\resources\\verge-mihomo.exe",
];

/** Root directory of this plugin package. */
export function pluginRoot() {
  return path.resolve(import.meta.dirname, "..");
}

/** DSH home directory, honouring DSH_HOME. */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".dsh");
}

/** Where this plugin keeps its config and logs. */
export function dataDir() {
  return path.join(dshHome(), "proxy-embedded");
}

/**
 * Resolve the mihomo binary.
 * @param {string} [configured] explicit path from settings.
 * @returns {string | undefined}
 */
export function resolveKernel(configured) {
  if (typeof configured === "string" && configured.trim() !== "") {
    const p = configured.trim();
    if (existsSync(p)) return p;
  }
  for (const candidate of BUNDLED_CANDIDATES) {
    const p = path.join(pluginRoot(), candidate);
    if (existsSync(p)) return p;
  }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build a minimal mihomo config from converted proxies.
 * @param {{ port: number, proxies: object[], proxyGroups?: object[], rules?: string[] }} input
 * @returns {string} YAML text
 */
export function buildConfig(input) {
  const port = Number.isFinite(input.port) ? input.port : DEFAULT_PORT;
  const proxies = Array.isArray(input.proxies) ? input.proxies : [];
  const proxyGroups = Array.isArray(input.proxyGroups) && input.proxyGroups.length > 0
    ? input.proxyGroups
    : [
        {
          name: "PROXY",
          type: "select",
          proxies: proxies.length > 0 ? ["AUTO", ...proxies.map((p) => p.name)] : ["DIRECT"],
        },
        {
          name: "AUTO",
          type: "url-test",
          url: "https://www.gstatic.com/generate_204",
          interval: 300,
          proxies: proxies.map((p) => p.name),
        },
      ];
  const rules = Array.isArray(input.rules) && input.rules.length > 0
    ? input.rules
    : ["GEOIP,LAN,DIRECT", "GEOIP,CN,DIRECT", "MATCH,PROXY"];

  return [
    `mixed-port: ${port}`,
    "allow-lan: false",
    "mode: rule",
    "log-level: warning",
    "ipv6: false",
    "proxies:",
    ...proxies.map((p) => "  " + JSON.stringify(p)),
    "proxy-groups:",
    ...proxyGroups.map((g) => "  " + JSON.stringify(g)),
    "rules:",
    ...rules.map((r) => "  - " + r),
    "",
  ].join("\n");
}

/**
 * Write the config file and return its path.
 * @param {string} yaml
 * @returns {Promise<string>}
 */
export async function writeConfig(yaml) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "config.yaml");
  await writeFile(file, yaml, "utf8");
  return file;
}

/** Whether something accepts TCP connections on the port. */
export function isPortOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Find a free TCP port starting from `from`. */
export async function findFreePort(from = DEFAULT_PORT) {
  for (let port = from; port < from + 50; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPortOpen(port, 150))) return port;
  }
  return from;
}

/**
 * Create the core manager.
 * @param {{ log?: (level: string, message: string) => void, kernelPath?: string, port?: number }} [options]
 */
export function createCore(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  let child;
  let runningPort;

  function isRunning() {
    return child !== undefined && child.exitCode === null && !child.killed;
  }

  function getPort() {
    return runningPort;
  }

  /**
   * Start the core on `port` with the given config.
   * @param {{ port: number, yaml: string }} input
   * @returns {Promise<{ ok: true, port: number, kernel: string } | { ok: false, reason: string }>}
   */
  async function start(input) {
    if (isRunning()) {
      return { ok: true, port: runningPort, kernel: child.spawnfile };
    }
    const kernel = resolveKernel(options.kernelPath);
    if (!kernel) {
      return { ok: false, reason: "找不到 mihomo 内核，请把 mihomo.exe 放进插件 bin/ 目录，或在设置里填写 kernelPath" };
    }
    const dir = dataDir();
    await mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "config.yaml");
    await writeFile(configPath, input.yaml, "utf8");

    let port = Number.isFinite(input.port) ? input.port : DEFAULT_PORT;
    if (await isPortOpen(port, 150)) port = await findFreePort(port + 1);

    return await new Promise((resolve) => {
      const proc = spawn(kernel, ["-d", dir, "-f", configPath], {
        cwd: dir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      proc.once("error", (error) => {
        settle({ ok: false, reason: "启动 mihomo 失败：" + (error && error.message ? error.message : String(error)) });
      });
      proc.once("exit", (code, signal) => {
        if (!settled) {
          settle({ ok: false, reason: "mihomo 提前退出（code=" + code + ", signal=" + signal + "）" });
        }
        child = undefined;
        runningPort = undefined;
      });
      if (proc.stdout) proc.stdout.on("data", (chunk) => log("debug", String(chunk).trim()));
      if (proc.stderr) proc.stderr.on("data", (chunk) => log("debug", String(chunk).trim()));

      const deadline = Date.now() + 8000;
      const probe = async () => {
        if (settled) return;
        if (await isPortOpen(port, 300)) {
          child = proc;
          runningPort = port;
          settle({ ok: true, port, kernel });
          return;
        }
        if (Date.now() > deadline) {
          try { proc.kill(); } catch { /* ignore */ }
          settle({ ok: false, reason: "mihomo 已启动但端口 " + port + " 未监听" });
          return;
        }
        setTimeout(probe, 200);
      };
      probe();
    });
  }

  /** Stop the core. */
  function stop() {
    const proc = child;
    child = undefined;
    runningPort = undefined;
    if (proc === undefined) return { ok: true, stopped: false };
    try { proc.kill(); } catch { /* ignore */ }
    return { ok: true, stopped: true };
  }

  /** Current state snapshot. */
  function status() {
    return {
      running: isRunning(),
      port: runningPort,
      pid: child !== undefined ? child.pid : undefined,
      kernel: child !== undefined ? child.spawnfile : resolveKernel(options.kernelPath),
    };
  }

  return { start, stop, status, isRunning, getPort, kernelPath: resolveKernel(options.kernelPath) };
}
