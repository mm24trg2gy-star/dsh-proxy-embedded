/**
 * 下载 mihomo 内核（用户本机没有 Clash Verge 时的兜底）。
 *
 * - 默认从 GitHub 官方 Release 找 windows-amd64 的 zip；
 * - 允许用户给一个镜像 URL（国内直连 GitHub 经常不通）；
 * - 下载后解压、试跑 `-v` 校验，再原子安装到 <data>/bin/mihomo.exe；
 * - 不信任任何未经验证的可执行文件：解压出来的 exe 必须先能跑出版本号。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";

import { dataDir } from "./core.js";

const RELEASE_API = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180000;

/** Only one download/install may run at a time. */
let inFlight = false;

/** Pick the windows-amd64 zip from a GitHub release payload (pure, unit-tested). */
export function chooseAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const candidates = assets.filter((asset) => {
    const name = String(asset && asset.name ? asset.name : "").toLowerCase();
    return name.endsWith(".zip") && name.includes("windows-amd64");
  });
  const plain = candidates.filter((asset) => {
    const name = String(asset.name).toLowerCase();
    return !name.includes("compatible") && !/go1d{2}/.test(name);
  });
  if (plain.length > 0) return plain.sort((a, b) => String(a.name).localeCompare(String(b.name)))[0];
  const compatible = candidates.find((asset) => /compatible/.test(String(asset.name).toLowerCase()));
  return compatible || candidates[0] || null;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\]|::1$)/i;

/** Only https URLs, no embedded credentials, no loopback/LAN targets. */
export function normalizeDownloadUrl(input) {
  if (typeof input !== "string" || input.trim() === "") return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (PRIVATE_HOST.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function resolveAssetUrl(mirror) {
  if (mirror !== null) return { ok: true, url: mirror, source: "mirror" };
  const response = await fetch(RELEASE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-proxy-embedded" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return { ok: false, reason: "读取官方 Release 失败：HTTP " + response.status };
  const release = await response.json();
  const asset = chooseAsset(release);
  if (asset === null) return { ok: false, reason: "官方 Release 里没有 windows-amd64 的 zip" };
  return { ok: true, url: asset.browser_download_url, source: "github", tag: release.tag_name };
}

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/;

function addressIsPrivate(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  return PRIVATE_V4.test(value);
}

/** Resolve the host and refuse anything that lands on loopback / LAN / link-local. */
async function assertPublicHost(hostname) {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  const list = Array.isArray(answers) ? answers : [answers];
  if (list.length === 0) return { ok: false, reason: "域名解析不出地址：" + hostname };
  for (const answer of list) {
    if (addressIsPrivate(answer && answer.address)) return { ok: false, reason: "拒绝访问内网地址：" + hostname };
  }
  return { ok: true };
}

/** Follow redirects manually so every hop passes the same URL + address policy. */
async function downloadToFile(url, file) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const checked = normalizeDownloadUrl(current);
    if (checked === null) return { ok: false, reason: "下载地址不合法（只允许 https，且不能是内网）" };
    const host = new URL(checked).hostname;
    const resolved = await assertPublicHost(host);
    if (resolved.ok !== true) return resolved;

    const response = await fetch(checked, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || location === "") return { ok: false, reason: "下载跳转缺少目标地址" };
      current = new URL(location, checked).href;
      continue;
    }
    if (!response.ok) return { ok: false, reason: "下载失败：HTTP " + response.status };

    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) return { ok: false, reason: "内核包太大（" + length + " 字节），拒绝下载" };
    const reader = response.body ? response.body.getReader() : null;
    if (reader === null) return { ok: false, reason: "下载响应没有正文" };
    const handle = await open(file, "w");
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return { ok: false, reason: "内核包超过大小上限" };
        }
        // 背压写盘：一次只在内存里留一个 chunk
        await handle.write(value);
      }
    } finally {
      await handle.close();
    }
    if (total === 0) return { ok: false, reason: "下载到的是空文件" };
    return { ok: true, bytes: total };
  }
  return { ok: false, reason: "下载跳转次数过多" };
}

function expandArchive(zip, dir) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dir.replace(/'/g, "''") + "' -Force",
  ], { windowsHide: true, encoding: "utf8", timeout: 120000 });
  return result.status === 0;
}

function findExe(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) stack.push(full);
      else if (/^mihomo.*\.exe$/i.test(name) || /^verge-mihomo.*\.exe$/i.test(name)) return full;
    }
  }
  return null;
}

/** Extract, prove it runs, then publish to <data>/bin/mihomo.exe. */
export async function downloadKernel(options = {}) {
  if (inFlight) return { ok: false, reason: "已有一次内核下载在进行，请稍候" };
  inFlight = true;
  try {
    return await downloadKernelInner(options);
  } finally {
    inFlight = false;
  }
}

async function downloadKernelInner(options = {}) {
  const mirror = normalizeDownloadUrl(options.url);
  if (options.url !== undefined && options.url !== null && options.url !== "" && mirror === null) {
    return { ok: false, reason: "下载地址必须是 http(s) URL" };
  }

  const resolved = await resolveAssetUrl(mirror);
  if (resolved.ok !== true) return resolved;

  const work = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-dl-"));
  const zip = path.join(work, "kernel.zip");
  const unpacked = path.join(work, "unpacked");
  try {
    mkdirSync(unpacked, { recursive: true });
    const downloaded = await downloadToFile(resolved.url, zip);
    if (downloaded.ok !== true) return downloaded;

    if (!expandArchive(zip, unpacked)) return { ok: false, reason: "解压失败（zip 可能损坏）" };
    const exe = findExe(unpacked);
    if (exe === null) return { ok: false, reason: "压缩包里没有 mihomo.exe" };

    const probe = spawnSync(exe, ["-v"], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    const version = String(probe.stdout || "").trim().split(/\r?\n/)[0];
    if (probe.status !== 0 || version === "") return { ok: false, reason: "下载到的内核跑不起来（-v 失败）" };

    const targetDir = path.join(dataDir(), "bin");
    mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, "mihomo.exe");
    const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
    copyFileSync(exe, tmp);
    const hash = createHash("sha256").update(readFileSync(tmp)).digest("hex");
    copyFileSync(tmp, target);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    writeFileSync(target + ".sha256", hash + "\n", "utf8");
    return { ok: true, path: target, version, source: resolved.source, bytes: downloaded.bytes };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
