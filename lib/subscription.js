/**
 * Subscription fetching and format detection.
 *
 * Supported formats:
 *   - clash   : complete Clash YAML (used as-is)
 *   - base64  : base64 of a newline-separated node list (V2Ray / Shadowrocket / Hiddify)
 *   - singbox : sing-box JSON config (converted)
 *   - surge   : Surge INI config (converted)
 *
 * @module dsh-proxy-embedded/subscription
 */

/** Decode a base64 string leniently; returns undefined when it is not base64. */
export function tryBase64(text) {
  const cleaned = String(text).replace(/\s+/g, "");
  if (cleaned === "" || cleaned.length % 4 === 1) return undefined;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) return undefined;
  try {
    const decoded = Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return decoded.includes("://") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect a subscription payload's format.
 * @param {string} text
 * @returns {"clash" | "base64" | "singbox" | "surge" | "unknown"}
 */
export function detectFormat(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (trimmed === "") return "unknown";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && (parsed.outbounds || parsed.inbounds)) return "singbox";
      return "unknown";
    } catch {
      /* fall through to other checks */
    }
  }

  if (trimmed.includes("proxies:") || trimmed.includes("mixed-port") || trimmed.includes("proxy-groups:")) {
    return "clash";
  }
  if (trimmed.includes("[Proxy]") || trimmed.includes("[Proxy Group]") || trimmed.includes("[ProxyGroup]")) {
    return "surge";
  }
  if (tryBase64(trimmed) !== undefined) return "base64";
  return "unknown";
}

/**
 * Fetch a subscription URL.
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 */
export async function fetchSubscription(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "mihomo/dsh-proxy-embedded",
        Accept: "*/*",
      },
    });
    if (!response.ok) return { ok: false, reason: "HTTP " + response.status + " " + response.statusText };
    const text = await response.text();
    if (text.trim() === "") return { ok: false, reason: "订阅返回空内容" };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-call import: fetch, detect, and hand the payload to a converter.
 * @param {string} url
 * @param {(format: string, text: string) => Promise<{ ok: boolean, yaml?: string, proxies?: object[], reason?: string }>} converter
 */
export async function importSubscription(url, converter) {
  const fetched = await fetchSubscription(url);
  if (fetched.ok !== true) return { ok: false, reason: fetched.reason };
  const format = detectFormat(fetched.text);
  if (format === "unknown") return { ok: false, reason: "无法识别订阅格式（既不是 Clash YAML、base64 节点列表，也不是 sing-box / Surge 配置）" };
  const converted = await converter(format, fetched.text);
  if (converted.ok !== true) return { ok: false, reason: converted.reason || "转换失败" };
  return { ok: true, format, ...converted };
}
