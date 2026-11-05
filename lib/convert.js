/**
 * Convert subscription payloads into mihomo `proxies:` entries.
 *
 * Supported inputs:
 *   - base64 node list  : ss:// vmess:// vless:// trojan:// hysteria2:// ssr://
 *   - sing-box JSON     : outbounds with shadowsocks / vmess / vless / trojan / hysteria2
 *   - Surge INI         : [Proxy] section
 *
 * A conversion failure never throws; it returns { ok: false, reason }.
 *
 * @module dsh-proxy-embedded/convert
 */

/** Decode leniently (accepts url-safe base64 too). */
function b64(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function splitName(uri) {
  const hash = uri.indexOf("#");
  if (hash < 0) return { body: uri, name: "" };
  return { body: uri.slice(0, hash), name: decodeURIComponent(uri.slice(hash + 1)) };
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseSs(uri) {
  const { body, name } = splitName(uri);
  const rest = body.slice("ss://".length);
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const userInfo = b64(rest.slice(0, at));
    const colon = userInfo.indexOf(":");
    if (colon < 0) return undefined;
    const method = userInfo.slice(0, colon);
    const password = userInfo.slice(colon + 1);
    const hostPort = rest.slice(at + 1);
    const idx = hostPort.lastIndexOf(":");
    const server = hostPort.slice(0, idx);
    const port = Number(hostPort.slice(idx + 1));
    if (!server || !Number.isFinite(port)) return undefined;
    return { name: name || server, type: "ss", server, port, cipher: method, password };
  }
  const decoded = b64(rest);
  const match = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
  if (!match) return undefined;
  return {
    name: name || match[3],
    type: "ss",
    server: match[3],
    port: Number(match[4]),
    cipher: match[1],
    password: match[2],
  };
}

function parseVmess(uri) {
  const { name } = splitName(uri);
  const raw = uri.slice("vmess://".length);
  const body = raw.includes("#") ? raw.slice(0, raw.indexOf("#")) : raw;
  let json;
  try { json = JSON.parse(b64(body)); } catch { return undefined; }
  if (!json || typeof json !== "object" || !json.add) return undefined;
  const proxy = {
    name: name || json.ps || json.add,
    type: "vmess",
    server: json.add,
    port: Number(json.port),
    uuid: json.id,
    alterId: Number(json.aid || 0),
    cipher: json.scy || "auto",
  };
  if (json.tls === "tls") proxy.tls = true;
  if (json.sni) proxy.servername = json.sni;
  if (json.net && json.net !== "tcp") proxy.network = json.net;
  if (json.path) proxy["ws-opts"] = { path: json.path };
  if (json.host) proxy["ws-opts"] = { ...(proxy["ws-opts"] || {}), headers: { Host: json.host } };
  return proxy;
}

function parseUrlLike(uri, type) {
  const { body, name } = splitName(uri);
  let url;
  try { url = new URL(body); } catch { return undefined; }
  const server = url.hostname;
  const port = Number(url.port);
  if (!server || !Number.isFinite(port)) return undefined;
  const q = url.searchParams;
  const proxy = { name: name || server, type, server, port };
  if (type === "vless") proxy.uuid = safeDecode(url.username);
  if (type === "trojan") proxy.password = safeDecode(url.username);
  if (type === "hysteria2") proxy.password = safeDecode(url.username);
  const sni = q.get("sni") || q.get("peer");
  if (sni) proxy.servername = sni;
  const security = q.get("security");
  if (security === "tls" || security === "reality" || q.get("tls") === "1") proxy.tls = true;
  const network = q.get("type") || q.get("network");
  if (network && network !== "tcp") proxy.network = network;
  const pathValue = q.get("path");
  if (pathValue) proxy["ws-opts"] = { path: pathValue };
  const host = q.get("host");
  if (host) proxy["ws-opts"] = { ...(proxy["ws-opts"] || {}), headers: { Host: host } };
  if (type === "hysteria2") {
    const obfs = q.get("obfs");
    if (obfs) proxy.obfs = obfs;
    const obfsPassword = q.get("obfs-password");
    if (obfsPassword) proxy["obfs-password"] = obfsPassword;
  }
  return proxy;
}

function parseSsr(uri) {
  const raw = uri.slice("ssr://".length);
  let decoded;
  try { decoded = b64(raw); } catch { return undefined; }
  const main = decoded.split("/?")[0];
  const parts = main.split(":");
  if (parts.length < 6) return undefined;
  const [server, port, protocol, method, obfs, password] = parts;
  return {
    name: server,
    type: "ssr",
    server,
    port: Number(port),
    cipher: method,
    password: b64(password),
    protocol,
    obfs,
  };
}

/**
 * Parse a single node URI into a mihomo proxy object.
 * @param {string} uri
 */
export function parseNode(uri) {
  const text = String(uri || "").trim();
  if (text.startsWith("ss://")) return parseSs(text);
  if (text.startsWith("vmess://")) return parseVmess(text);
  if (text.startsWith("vless://")) return parseUrlLike(text, "vless");
  if (text.startsWith("trojan://")) return parseUrlLike(text, "trojan");
  if (text.startsWith("hysteria2://") || text.startsWith("hy2://")) return parseUrlLike(text, "hysteria2");
  if (text.startsWith("ssr://")) return parseSsr(text);
  return undefined;
}

/**
 * Convert a base64-encoded node list.
 * @param {string} text
 */
export function convertBase64List(text) {
  const decoded = b64(String(text).replace(/\s+/g, ""));
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const proxies = [];
  const failures = [];
  for (const line of lines) {
    const proxy = parseNode(line);
    if (proxy) proxies.push(proxy);
    else failures.push(line.slice(0, 24));
  }
  if (proxies.length === 0) {
    return { ok: false, reason: "base64 列表里没有可识别的节点（" + failures.length + " 行无法解析）" };
  }
  return { ok: true, proxies, failures: failures.length };
}

/** Map a sing-box outbound to a mihomo proxy. */
function fromSingBox(outbound) {
  if (!outbound || typeof outbound !== "object") return undefined;
  const tag = outbound.tag || outbound.server;
  const server = outbound.server;
  const port = Number(outbound.server_port);
  if (!server || !Number.isFinite(port)) return undefined;
  switch (outbound.type) {
    case "shadowsocks":
      return {
        name: tag,
        type: "ss",
        server,
        port,
        cipher: outbound.method,
        password: outbound.password,
      };
    case "vmess":
      return {
        name: tag,
        type: "vmess",
        server,
        port,
        uuid: outbound.uuid,
        alterId: Number(outbound.alter_id || 0),
        cipher: outbound.security || "auto",
        tls: Boolean(outbound.tls && outbound.tls.enabled),
      };
    case "vless":
      return {
        name: tag,
        type: "vless",
        server,
        port,
        uuid: outbound.uuid,
        tls: Boolean(outbound.tls && outbound.tls.enabled),
        servername: outbound.tls && outbound.tls.server_name,
      };
    case "trojan":
      return {
        name: tag,
        type: "trojan",
        server,
        port,
        password: outbound.password,
        servername: outbound.tls && outbound.tls.server_name,
      };
    case "hysteria2":
      return {
        name: tag,
        type: "hysteria2",
        server,
        port,
        password: outbound.password,
      };
    default:
      return undefined;
  }
}

/**
 * Convert a sing-box JSON config.
 * @param {string} text
 */
export function convertSingBox(text) {
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: "sing-box JSON 解析失败" }; }
  const outbounds = Array.isArray(json && json.outbounds) ? json.outbounds : [];
  const proxies = outbounds.map(fromSingBox).filter(Boolean);
  if (proxies.length === 0) return { ok: false, reason: "sing-box 配置里没有可转换的 outbound" };
  return { ok: true, proxies };
}

/** Parse a Surge [Proxy] line: `name = ss, host, port, encrypt-method=..., password=...`. */
function fromSurgeLine(line) {
  const eq = line.indexOf("=");
  if (eq < 0) return undefined;
  const name = line.slice(0, eq).trim();
  const fields = line.slice(eq + 1).split(",").map((part) => part.trim());
  const type = fields[0];
  const server = fields[1];
  const port = Number(fields[2]);
  if (!name || !server || !Number.isFinite(port)) return undefined;
  const kv = {};
  for (const field of fields.slice(3)) {
    const idx = field.indexOf("=");
    if (idx > 0) kv[field.slice(0, idx).trim()] = field.slice(idx + 1).trim();
  }
  if (type === "ss") {
    return {
      name,
      type: "ss",
      server,
      port,
      cipher: kv["encrypt-method"] || kv.method || "aes-128-gcm",
      password: kv.password || "",
    };
  }
  if (type === "vmess") {
    return {
      name,
      type: "vmess",
      server,
      port,
      uuid: kv.username || kv.uuid,
      alterId: Number(kv["alter-id"] || 0),
      cipher: "auto",
      tls: kv.tls === "true",
    };
  }
  if (type === "trojan") {
    return { name, type: "trojan", server, port, password: kv.password || "" };
  }
  return undefined;
}

/**
 * Convert a Surge INI config.
 * @param {string} text
 */
export function convertSurge(text) {
  const lines = String(text).split(/\r?\n/);
  const proxies = [];
  let inProxy = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) {
      inProxy = /^\[Proxy\]$/i.test(line);
      continue;
    }
    if (!inProxy || line === "" || line.startsWith("#") || line.startsWith("//")) continue;
    const proxy = fromSurgeLine(line);
    if (proxy) proxies.push(proxy);
  }
  if (proxies.length === 0) return { ok: false, reason: "Surge 配置里没有可转换的 [Proxy] 条目" };
  return { ok: true, proxies };
}

/**
 * Rewrite a Clash YAML subscription so it listens on the port the plugin can
 * probe, and drop the controller/secret that would collide with a running
 * Clash Verge instance.
 *
 * Subscriptions usually hard-code `port: 7890`, `socks-port`, `redir-port` and
 * `external-controller: 0.0.0.0:9090`; left untouched, the core starts on the
 * subscription's port and the plugin waits forever on its own.
 *
 * @param {string} yaml
 * @param {number} port
 * @returns {string}
 */
export function rewriteClashYaml(yaml, port) {
  let out = String(yaml || "");
  out = out.replace(/^external-controller:.*$/gm, "");
  out = out.replace(/^secret:.*$/gm, "");
  out = out.replace(/^socks-port:.*$/gm, "");
  out = out.replace(/^redir-port:.*$/gm, "");
  out = out.replace(/^allow-lan:.*$/gm, "allow-lan: false");
  if (/^mixed-port:/m.test(out)) {
    out = out.replace(/^mixed-port:.*$/gm, "mixed-port: " + port);
  } else if (/^port:/m.test(out)) {
    out = out.replace(/^port:.*$/gm, "mixed-port: " + port);
  } else {
    out = "mixed-port: " + port + "\n" + out;
  }
  return out;
}

/**
 * Convert any supported payload.
 * @param {"clash" | "base64" | "singbox" | "surge"} format
 * @param {string} text
 * @param {{ port?: number }} [options]
 */
export function convert(format, text, options = {}) {
  if (format === "base64") return convertBase64List(text);
  if (format === "singbox") return convertSingBox(text);
  if (format === "surge") return convertSurge(text);
  if (format === "clash") {
    const port = Number.isFinite(options.port) ? options.port : 7899;
    return { ok: true, proxies: [], passthrough: true, yaml: rewriteClashYaml(text, port) };
  }
  return { ok: false, reason: "不支持的订阅格式：" + format };
}
