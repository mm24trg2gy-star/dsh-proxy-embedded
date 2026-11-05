import test from "node:test";
import assert from "node:assert/strict";
import { detectFormat } from "../lib/subscription.js";
import { convert, parseNode } from "../lib/convert.js";

const ssUri = "ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@1.2.3.4:8388#test";
const vmessJson = {
  v: "2",
  ps: "vm",
  add: "5.6.7.8",
  port: "443",
  id: "uuid-1",
  aid: "0",
  net: "ws",
  tls: "tls",
  host: "example.com",
  path: "/ws",
};
const vmessUri = "vmess://" + Buffer.from(JSON.stringify(vmessJson)).toString("base64");

test("detect: clash yaml", () => {
  assert.equal(detectFormat("mixed-port: 7890\nproxies:\n  - name: a\n"), "clash");
});

test("detect: base64 node list", () => {
  const list = Buffer.from(ssUri).toString("base64");
  assert.equal(detectFormat(list), "base64");
});

test("detect: sing-box json", () => {
  assert.equal(detectFormat(JSON.stringify({ outbounds: [] })), "singbox");
});

test("detect: surge ini", () => {
  assert.equal(detectFormat("[Proxy]\ns1 = ss, 1.2.3.4, 8388\n"), "surge");
});

test("parse: ss node", () => {
  const proxy = parseNode(ssUri);
  assert.equal(proxy.type, "ss");
  assert.equal(proxy.server, "1.2.3.4");
  assert.equal(proxy.port, 8388);
  assert.equal(proxy.cipher, "aes-128-gcm");
  assert.equal(proxy.password, "password");
  assert.equal(proxy.name, "test");
});

test("parse: vmess node", () => {
  const proxy = parseNode(vmessUri);
  assert.equal(proxy.type, "vmess");
  assert.equal(proxy.server, "5.6.7.8");
  assert.equal(proxy.port, 443);
  assert.equal(proxy.uuid, "uuid-1");
  assert.equal(proxy.tls, true);
});

test("convert: base64 list with two nodes", () => {
  const list = Buffer.from(ssUri + "\n" + vmessUri).toString("base64");
  const result = convert("base64", list);
  assert.equal(result.ok, true);
  assert.equal(result.proxies.length, 2);
});

test("convert: sing-box outbound", () => {
  const json = JSON.stringify({
    outbounds: [
      { type: "shadowsocks", tag: "s1", server: "9.9.9.9", server_port: 8388, method: "aes-128-gcm", password: "p" },
      { type: "vless", tag: "v1", server: "8.8.8.8", server_port: 443, uuid: "u", tls: { enabled: true, server_name: "x.com" } },
    ],
  });
  const result = convert("singbox", json);
  assert.equal(result.ok, true);
  assert.equal(result.proxies.length, 2);
  assert.equal(result.proxies[0].type, "ss");
  assert.equal(result.proxies[1].type, "vless");
});

test("convert: surge proxy section", () => {
  const ini = "[Proxy]\ns1 = ss, 9.9.9.9, 8388, encrypt-method=aes-128-gcm, password=p\n";
  const result = convert("surge", ini);
  assert.equal(result.ok, true);
  assert.equal(result.proxies[0].name, "s1");
});

test("convert: unsupported input reports failure, never throws", () => {
  const result = convert("base64", Buffer.from("not a node").toString("base64"));
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});
