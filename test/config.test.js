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
  assert.ok(p >= 0);
  assert.match(lines[p + 1], /^ {2}- \{/);
  const g = lines.indexOf("proxy-groups:");
  assert.ok(g >= 0);
  assert.match(lines[g + 1], /^ {2}- \{/);
  for (const rule of SAFE_RULES) assert.ok(yaml.includes(rule), "missing rule: " + rule);
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
  assert.ok(yaml.includes('"name":"ss-1"'));
  assert.ok(yaml.includes('"name":"dup (2)"'));
  assert.ok(!yaml.includes("null"));
});

test("clash sanitising strips the dangerous top-level blocks and forces the baseline", () => {
  const input = [
    "mixed-port: 7890",
    "allow-lan: true",
    "tun:",
    "  enable: true",
    "listeners:",
    "  - {name: open, type: socks, port: 7892, listen: 0.0.0.0}",
    "external-controller: 0.0.0.0:9090",
    "proxies:",
    "  - {name: A, type: anytls, server: 1.1.1.1, port: 443, password: x, sni: a.example.com}",
    "proxy-groups:",
    "  - {name: PROXY, type: select, proxies: [A]}",
    "rules:",
    "  - MATCH,PROXY",
  ].join("\n");

  const out = rewriteClashYaml(input, 7899);
  assert.ok(typeof out === "string");
  assert.ok(!/^tun:/m.test(out));
  assert.ok(!/^listeners:/m.test(out));
  assert.ok(!/external-controller:/m.test(out));
  assert.ok(/allow-lan: false/.test(out));
  assert.ok(out.includes("mixed-port: 7899"));
  assert.ok(out.includes("anytls"));
  assert.ok(out.includes("IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"));
});

test("clash sanitising keeps dns / providers / rules (they make fake-IP and providers work)", () => {
  const input = [
    "dns:",
    "  enable: true",
    "  enhanced-mode: fake-ip",
    "  nameserver: [223.5.5.5]",
    "proxy-providers:",
    "  p1: {type: http, url: 'https://example.com/sub'}",
    "proxies:",
    "  - {name: A, type: anytls, server: 1.1.1.1, port: 443, password: x}",
    "rules:",
    "  - MATCH,DIRECT",
  ].join("\n");
  const out = rewriteClashYaml(input, 7899);
  assert.ok(typeof out === "string");
  assert.ok(/^dns:/m.test(out));
  assert.ok(/^proxy-providers:/m.test(out));
  assert.ok(out.includes("fake-ip"));
});

test("invalid YAML is rejected instead of producing a broken config", () => {
  assert.equal(rewriteClashYaml("proxies: [ this is not: a mapping", 7899), null);
  const result = convert("clash", "proxies: [ this is not: a mapping");
  assert.equal(result.ok, false);
  assert.match(result.reason, /无法安全清洗/);
});

test("dropTopLevelBlocks keeps nested content of surviving blocks", () => {
  const text = ["a:", "  x: 1", "b:", "  y: 2", "c:", "  z: 3"].join("\n");
  const out = dropTopLevelBlocks(text, ["b"]);
  assert.ok(out.includes("a:"));
  assert.ok(out.includes("  x: 1"));
  assert.ok(!out.includes("b:"));
  assert.ok(!out.includes("  y: 2"));
  assert.ok(out.includes("c:"));
});
