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

import YAML from "yaml";
import { SAFE_RULES, buildConfig } from "./core.js";

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
 * 订阅是远程内容，不能把“策略”一起交出去：tun 会劫持整机流量、listeners 会开
 * 自定义入站、proxy-providers 会让内核替订阅方请求任意地址。这里按顶层块整段删除，
 * 再强制回写安全基线（mixed-port / allow-lan / ipv6 / mode / log-level）。
 *
 * @param {string} yaml
 * @param {number} port
 * @returns {string}
 */
const DROP_TOP_LEVEL = [
  "tun",
  "listeners",
  "proxy-providers",
  "rule-providers",
  "dns",
  "hosts",
  "bind-address",
  "authentication",
  "external-controller",
  "external-controller-tls",
  "external-ui",
  "external-ui-url",
  "secret",
  "profile",
  "tunnels",
  "tproxy-port",
  "redir-port",
  "socks-port",
  "port",
  "mixed-port",
  "allow-lan",
  "ipv6",
  "mode",
  "log-level",
  "interface-name",
  "routing-mark",
];

/** Remove whole top-level blocks (the key line plus every indented line under it). */
export function dropTopLevelBlocks(text, keys) {
  const drop = new Set(keys);
  const out = [];
  let dropping = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const top = /^["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(line);
    if (top) {
      dropping = drop.has(top[1]);
      if (dropping) continue;
      out.push(line);
      continue;
    }
    if (!dropping) out.push(line);
  }
  return out.join("\n");
}

const MAX_CLASH_BYTES = 512 * 1024;

/** Only these node fields are copied out of a subscription. */
const ALLOWED_PROXY_KEYS = [
  "name", "type", "server", "port", "cipher", "password", "uuid", "alterId",
  "tls", "sni", "servername", "network", "ws-opts", "grpc-opts", "reality-opts",
  "client-fingerprint", "fingerprint", "flow", "skip-cert-verify", "udp",
  "plugin", "plugin-opts", "obfs", "obfs-password", "protocol", "protocol-param",
  "auth", "username", "ws-path", "ws-headers", "h2-opts", "http-opts", "up", "down",
];

/** Never pass these through, even if present. */
const BLOCKED_PROXY_KEYS = ["dialer-proxy", "interface-name", "routing-mark", "mptcp"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild a Clash subscription from scratch: parse the YAML, keep only the node
 * whitelist and a validated set of groups/rules, then let buildConfig emit the
 * listener, safety baseline and always-direct rules.
 *
 * @returns {string | null} null when the subscription cannot be handled safely
 */
export function rebuildClashConfig(text, port) {
  const raw = String(text || "");
  if (Buffer.byteLength(raw, "utf8") > MAX_CLASH_BYTES) return null;

  let doc;
  try {
    doc = YAML.parse(raw, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;

  const rawProxies = Array.isArray(doc.proxies) ? doc.proxies.filter(isPlainObject) : [];
  const proxies = rawProxies
    .map((node) => {
      const clean = {};
      for (const [key, value] of Object.entries(node)) {
        if (BLOCKED_PROXY_KEYS.includes(key)) continue;
        if (!ALLOWED_PROXY_KEYS.includes(key)) continue;
        clean[key] = value;
      }
      return clean;
    })
    .filter((node) => typeof node.name === "string" && node.name.trim() !== "" && typeof node.type === "string");
  if (proxies.length === 0) return null;

  const names = new Set(proxies.map((node) => node.name.trim()));

  const ALLOWED_GROUP_KEYS = ["name", "type", "proxies", "url", "interval", "tolerance", "lazy", "timeout", "disable-udp", "hidden", "icon", "strategy"];

  const rawGroups = Array.isArray(doc["proxy-groups"]) ? doc["proxy-groups"].filter(isPlainObject) : [];
  let groups = rawGroups
    .map((group) => {
      const out = { name: typeof group.name === "string" ? group.name.trim() : "", type: typeof group.type === "string" ? group.type : "select" };
      for (const key of ALLOWED_GROUP_KEYS) {
        if (key === "name" || key === "type" || key === "proxies") continue;
        if (group[key] !== undefined) out[key] = group[key];
      }
      out.proxies = Array.isArray(group.proxies)
        ? group.proxies.map((ref) => (typeof ref === "string" ? ref.trim() : "")).filter((ref) => ref !== "")
        : [];
      return out;
    })
    .filter((group) => group.name !== "" && group.type !== "" && group.proxies.length > 0);

  // Iteratively drop dangling references and emptied groups: a trimmed group must not
  // leave other groups or rules pointing at a name that no longer exists.
  const proxyNames = new Set(proxies.map((node) => node.name.trim()));
  for (let changed = true; changed;) {
    changed = false;
    const alive = new Set([...proxyNames, ...groups.map((group) => group.name)]);
    for (const group of groups) {
      const refs = group.proxies.filter((ref) => ref === "DIRECT" || ref === "REJECT" || alive.has(ref));
      if (refs.length !== group.proxies.length) {
        group.proxies = refs;
        changed = true;
      }
    }
    const before = groups.length;
    groups = groups.filter((group) => group.proxies.length > 0);
    if (groups.length !== before) changed = true;
  }

  // Name conflicts + reference cycles: a group may not reuse a node name, and groups
  // that only point at each other must be dropped before rules are validated.
  groups = groups.filter((group) => !proxyNames.has(group.name));
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const cyclic = new Set();
  for (const start of groups) {
    const seen = new Set();
    let cursor = start;
    while (cursor !== undefined) {
      if (seen.has(cursor.name)) { for (const name of seen) cyclic.add(name); break; }
      seen.add(cursor.name);
      const nextName = cursor.proxies.find((ref) => groupByName.has(ref));
      cursor = nextName === undefined ? undefined : groupByName.get(nextName);
    }
  }
  groups = groups.filter((group) => !cyclic.has(group.name));
  const finalGroupNames = new Set(groups.map((group) => group.name));
  for (const group of groups) {
    group.proxies = group.proxies.filter((ref) => !cyclic.has(ref) && (!groupByName.has(ref) || finalGroupNames.has(ref)));
    if (group.proxies.length === 0) group.proxies.push("DIRECT");
    if (["url-test", "fallback", "load-balance"].includes(group.type) && typeof group.url !== "string") {
      group.url = "https://www.gstatic.com/generate_204";
    }
  }

  // Rules must point at something that actually exists after trimming.
  const finalNames = new Set([...proxyNames, ...finalGroupNames, "DIRECT", "REJECT"]);
  const RULE_VALUE_TYPES = new Set([
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "GEOSITE", "GEOIP",
    "IP-CIDR", "IP-CIDR6", "IP-ASN", "SRC-IP-CIDR", "SRC-PORT", "DST-PORT",
    "PROCESS-NAME", "PROCESS-PATH", "SRC-GEOIP", "DST-GEOIP",
  ]);
  const rules = (Array.isArray(doc.rules) ? doc.rules : [])
    .filter((rule) => typeof rule === "string")
    .map((rule) => rule.trim())
    .filter((rule) => {
      if (rule === "") return false;
      const parts = rule.split(",").map((part) => part.trim());
      const type = (parts[0] || "").toUpperCase();
      if (type === "MATCH" || type === "FINAL") return finalNames.has(parts[1] || "");
      if (!RULE_VALUE_TYPES.has(type)) return false; // RULE-SET / logical rules depend on removed providers
      return finalNames.has(parts[2] || "");
    });

  // Guarantee the default group used by the built-in MATCH rule exists.
  if (!finalGroupNames.has("PROXY")) {
    groups.unshift({ name: "PROXY", type: "select", proxies: ["DIRECT", ...proxyNames] });
  }  return buildConfig({
    port,
    proxies,
    proxyGroups: groups.length > 0 ? groups : undefined,
    rules: rules.length > 0 ? rules : undefined,
  });
}

/**
 * @returns {string | null} cleaned YAML, or null when it cannot be sanitized safely
 */
export function rewriteClashYaml(yaml, port) {
  return rebuildClashConfig(yaml, port);
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
    const cleaned = rewriteClashYaml(text, port);
    if (cleaned === null) {
      return { ok: false, reason: "这份 Clash 订阅包含无法安全清洗的写法（内联 rules 或带引号的危险顶层键），请改用节点列表订阅，或手动指定节点" };
    }
    return { ok: true, proxies: [], passthrough: true, yaml: cleaned };
  }
  return { ok: false, reason: "不支持的订阅格式：" + format };
}
