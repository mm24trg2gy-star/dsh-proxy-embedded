import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeKernel, runtimeKernelPath } from "../lib/core.js";

test("a Clash Verge kernel is copied out as our own mihomo.exe", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const source = path.join(home, "Clash Verge", "verge-mihomo.exe");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "fake-kernel-bytes");

    const used = materializeKernel(source);
    assert.equal(used, runtimeKernelPath());
    assert.ok(used.endsWith(path.join("bin", "mihomo.exe")));
    assert.equal(readFileSync(used, "utf8"), "fake-kernel-bytes");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("our own kernel path is not copied", () => {
  const kernel = "C:\\plugins\\dsh-proxy-embedded\\bin\\mihomo.exe";
  assert.equal(materializeKernel(kernel), kernel);
});

test("an empty kernel stays empty", () => {
  assert.equal(materializeKernel(undefined), undefined);
  assert.equal(materializeKernel(""), "");
});
