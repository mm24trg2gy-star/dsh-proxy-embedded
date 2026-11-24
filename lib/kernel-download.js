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
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dataDir } from "./core.js";

const RELEASE_API = "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
const MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180000;

/** Pick the windows-amd64 zip from a GitHub release payload (pure, unit-tested). */
export function chooseAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const candidates = assets.filter((asset) => {
    const name = String(asset && asset.name ? asset.name : "").toLowerCase();
    if (!name.endsWith(".zip")) return false;
    if (!name.includes("windows-amd64")) return false;
    if (name.includes("compatible")) return true;
    return true;
  });
  // Prefer the plain amd64 build, fall back to the "compatible" one.
  const plain = candidates.find((asset) => !/compatible/.test(String(asset.name).toLowerCase()));
  return plain || candidates[0] || null;
}

/** Only http(s) URLs are accepted for downloads. */
export function normalizeDownloadUrl(input) {
  if (typeof input !== "string" || input.trim() === "") return null;
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
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

async function downloadToFile(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) return { ok: false, reason: "下载失败：HTTP " + response.status };
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) return { ok: false, reason: "内核包太大（" + length + " 字节），拒绝下载" };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) return { ok: false, reason: "下载到的是空文件" };
  if (buffer.length > MAX_BYTES) return { ok: false, reason: "内核包超过大小上限" };
  await writeFile(file, buffer);
  return { ok: true, bytes: buffer.length };
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
