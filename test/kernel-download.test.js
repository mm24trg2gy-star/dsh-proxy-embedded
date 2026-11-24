import test from "node:test";
import assert from "node:assert/strict";

import { chooseAsset, normalizeDownloadUrl } from "../lib/kernel-download.js";

test("chooseAsset prefers the plain windows-amd64 zip", () => {
  const release = {
    tag_name: "v1.19.34",
    assets: [
      { name: "mihomo-windows-amd64-compatible-v1.19.34.zip", browser_download_url: "https://example.com/compatible.zip" },
      { name: "mihomo-windows-amd64-v1.19.34.zip", browser_download_url: "https://example.com/plain.zip" },
      { name: "mihomo-linux-amd64-v1.19.34.gz", browser_download_url: "https://example.com/linux.gz" },
    ],
  };
  const asset = chooseAsset(release);
  assert.ok(asset);
  assert.equal(asset.browser_download_url, "https://example.com/plain.zip");
});

test("chooseAsset falls back to the compatible build and rejects unrelated assets", () => {
  const compatibleOnly = chooseAsset({
    assets: [{ name: "mihomo-windows-amd64-compatible-v1.19.34.zip", browser_download_url: "https://example.com/c.zip" }],
  });
  assert.ok(compatibleOnly);
  assert.equal(chooseAsset({ assets: [{ name: "mihomo-linux-amd64.zip" }] }), null);
  assert.equal(chooseAsset({ assets: [] }), null);
  assert.equal(chooseAsset(null), null);
});

test("normalizeDownloadUrl accepts http(s) only", () => {
  assert.equal(normalizeDownloadUrl("https://example.com/a.zip"), "https://example.com/a.zip");
  assert.equal(normalizeDownloadUrl("http://example.com/a.zip"), null);
  assert.equal(normalizeDownloadUrl("file:///C:/a.zip"), null);
  assert.equal(normalizeDownloadUrl("ftp://example.com/a.zip"), null);
  assert.equal(normalizeDownloadUrl("   "), null);
  assert.equal(normalizeDownloadUrl(undefined), null);
  assert.equal(normalizeDownloadUrl("https://127.0.0.1/a.zip"), null);
  assert.equal(normalizeDownloadUrl("https://192.168.1.5/a.zip"), null);
  assert.equal(normalizeDownloadUrl("https://user:pass@example.com/a.zip"), null);
});
