import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig, SAFE_RULES } from "../lib/core.js";
import { rewriteClashYaml, dropTopLevelBlocks, convert } from "../lib/convert.js";

test("buildConfig emits YAML sequence items for proxies and groups", () => {
  const yaml = buildConfig({
    port: 7899,
    proxies: [{ name: "HK-01", type: "ss", server: "1.2.3.4", port: 443, cipher: "aes-128-gcm", password: "x" }],
  });
  const lines = yaml.split("\n");

  const p = lines.indexOf("proxies:");
  assert.ok(p >= 0, "should include proxies:");
  assert.match(lines[p + 1], /^ {2}- \{/, "proxies items must start with '- '");

  const g = lines.indexOf("proxy-groups:");
  assert.ok(g >= 0, "should include proxy-groups:");
  assert.match(lines[g + 1], /^ {2}- \{/, "proxy-groups items must start with '- '");

  for (const rule of SAFE_RULES) {
    assert.ok(yaml.includes(rule), "always-direct rule missing: " + rule);
  }
  assert.ok(!yaml.includes("  {\"name\""), "no bare JSON mapping rows");
});

test("buildConfig fills missing names and de-duplicates them", () => {
  const yaml = buildConfig({
    port: 7899,
    proxies: [
      { type: "ss", server: "a", port: 1, cipher: "x", password: "y" },
      { name: "", type: "ss", server: "b", port: 2, cipher: "x", password: "y" },
      { name: "dup", type: "ss", server: "c", port: 3, cipher: "x", password: "y" },
      { name: "dup", type: "ss", server: "d", port: 4, cipher: "x", password: "y" },
    ],
  });
  assert.ok(yaml.includes("\"name\":\"ss-1\""));
  assert.ok(yaml.includes("\"name\":\"ss-2\""));
  assert.ok(yaml.includes("\"name\":\"dup\""));
  assert.ok(yaml.includes("\"name\":\"dup (2)\""));
  assert.ok(!yaml.includes("null"), "no null entries in groups");
});

test("rewriteClashYaml drops policy blocks and forces the safe baseline", () => {
  const input = [
    "port: 7890",
    "socks-port: 7891",
    "allow-lan: true",
    "tun:",
    "  enable: true",
    "  auto-route: true",
    "listeners:",
    "  - {name: open, type: socks, port: 7892, listen: 0.0.0.0}",
    "proxy-providers:",
    "  p: {type: http, url: 'http://169.254.169.254/latest'}",
    "dns:",
    "  enable: true",
    "proxies:",
    "  - {name: A, type: ss, server: 1.1.1.1, port: 443}",
    "proxy-groups:",
    "  - {name: PROXY, type: select, proxies: [A]}",
    "rules:",
    "  - MATCH,PROXY",
  ].join("\n");

  const out = rewriteClashYaml(input, 7899);
  assert.ok(out.includes("mixed-port: 7899"));
  assert.ok(out.includes("allow-lan: false"));
  assert.ok(out.includes("ipv6: false"));

  for (const banned of ["tun:", "listeners:", "proxy-providers:", "dns:", "socks-port:"]) {
    assert.ok(!new RegExp("^" + banned, "m").test(out), "should drop top-level block: " + banned);
  }
  // 安全直连规则必须排在 rules 最前面
  assert.ok(out.includes("  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"));
  const rulesAt = out.indexOf("rules:");
  const safeAt = out.indexOf("IP-CIDR,127.0.0.0/8");
  assert.ok(rulesAt >= 0 && safeAt > rulesAt, "safe rules must live under rules:");
});

test("dropTopLevelBlocks keeps nested content of surviving blocks", () => {
  const text = ["a:", "  x: 1", "b:", "  y: 2", "c:", "  z: 3"].join("\n");
  const out = dropTopLevelBlocks(text, ["b"]);
  assert.ok(out.includes("a:"));
  assert.ok(out.includes("  x: 1"));
  assert.ok(!out.includes("b:"));
  assert.ok(!out.includes("  y: 2"));
  assert.ok(out.includes("c:"));
  assert.ok(out.includes("  z: 3"));
});

test("dropTopLevelBlocks also removes quoted top-level keys", () => {
  const text = ["\"tun\":", "  enable: true", "proxies:", "  - {name: A, type: ss}"].join("\n");
  const out = dropTopLevelBlocks(text, ["tun"]);
  assert.ok(!out.includes("enable: true"));
  assert.ok(!out.includes("\"tun\":"));
  assert.ok(out.includes("proxies:"));
});

test("inline rules are parsed and rebuilt with the safe baseline", () => {
  const text = ["proxies:", "  - {name: A, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x}", "rules: ['MATCH,DIRECT']"].join("\n");
  const out = rewriteClashYaml(text, 7899);
  assert.ok(typeof out === "string");
  assert.ok(out.includes("IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"));
  assert.ok(out.includes("MATCH,DIRECT"));
});

test("convert reports a clear failure when the subscription is not usable YAML", () => {
  const text = "proxies: [ this is not: a mapping";
  const result = convert("clash", text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /无法安全清洗/);
});

test("subscription policy blocks never reach the rebuilt config", () => {
  const text = [
    "tun: {enable: true}",
    "listeners: [{name: x, port: 1}]",
    "proxy-providers: {p: {url: 'http://169.254.169.254/'}}",
    "proxies:",
    "  - {name: A, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x}",
    "rules:",
    "  - MATCH,DIRECT",
  ].join("\n");
  const out = rewriteClashYaml(text, 7899);
  assert.ok(typeof out === "string");
  assert.ok(!/^tun:/m.test(out));
  assert.ok(!/^listeners:/m.test(out));
  assert.ok(!/^proxy-providers:/m.test(out));
  assert.ok(out.includes("allow-lan: false"));
});