import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("alpha kernels are recognised by file name even outside a Clash Verge folder", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const source = path.join(home, "somewhere", "verge-mihomo-alpha.exe");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "alpha-bytes");
    const used = materializeKernel(source);
    assert.ok(used.endsWith(path.join("bin", "mihomo.exe")));
    assert.equal(readFileSync(used, "utf8"), "alpha-bytes");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a second call reuses the verified copy instead of copying again", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const source = path.join(home, "Clash Verge", "verge-mihomo.exe");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "v1");
    const first = materializeKernel(source);
    writeFileSync(source, "v2");
    const second = materializeKernel(source);
    assert.equal(first, second);
    assert.equal(readFileSync(second, "utf8"), "v2");
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("no temp files are left behind", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const source = path.join(home, "Clash Verge", "verge-mihomo.exe");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "bytes");
    materializeKernel(source);
    const dir = path.join(home, "proxy-embedded", "bin");
    const names = readdirSync(dir);
    assert.deepEqual(names, ["mihomo.exe"]);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});