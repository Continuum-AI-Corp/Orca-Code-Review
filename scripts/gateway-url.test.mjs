// Where the OrcaRouter key may be sent in clear: nowhere but this machine.
//
// The proxy refused a plain-http gateway with a message that named neither the
// input to change nor how — and it was the only place that looked: the settings
// fetch (settings.mjs) and the run report (report.mjs) sent the same key, as a
// Bearer header, to whatever orcarouter-url said, http included, before the
// proxy ever ran. A self-hosted gateway on plain http therefore leaked the key
// across the network on every run and then failed with an unhelpful error.
//
// Now one judge (scripts/gateway-url.mjs, the rule OrcaRouter's own gateway
// keeps: credentials in clear only to this machine) is asked where the URL is
// resolved — the first step that reads it, which fails the run naming the
// input and the fix — and again wherever the key meets it: the proxy, the
// settings fetch and the run report. https anywhere; plain http only to
// localhost, 127.0.0.0/8 or [::1].

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { gatewayUrlProblem } from "./gateway-url.mjs";
import { createProxyServer } from "./fact-proxy.mjs";
import { step, runBashStep, ROOT } from "./test-helpers/action-yaml.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-url-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const OK = [
  "https://api.orcarouter.ai/v1/chat/completions",
  "https://gateway.internal:8443/orca/v1/chat/completions",
  "http://localhost:8080/v1/chat/completions",
  "http://LOCALHOST:8080/v1/chat/completions",
  "http://127.0.0.1:8080/v1/chat/completions",
  "http://127.5.6.7/v1/chat/completions",
  "http://127.1/v1/chat/completions",
  "http://[::1]:8080/v1/chat/completions",
];
const REFUSED = [
  "http://gateway.internal/v1/chat/completions",
  "http://10.0.0.5/v1/chat/completions",
  "http://192.168.1.10:3000/v1/chat/completions",
  "http://localhost.evil.example/v1/chat/completions",
  "http://127.0.0.1.nip.io/v1/chat/completions",
  "http://[::ffff:a00:5]/v1/chat/completions",
  "http://0.0.0.0/v1/chat/completions",
  "ftp://api.orcarouter.ai/v1",
  "file:///etc/passwd",
  "not a url",
  "",
];

describe("the judge", () => {
  for (const url of OK) test(`accepts ${url}`, () => assert.equal(gatewayUrlProblem(url), null));
  for (const url of REFUSED) {
    test(`refuses ${JSON.stringify(url)}, naming the input and the fix`, () => {
      const p = gatewayUrlProblem(url);
      assert.ok(p, "accepted");
      assert.match(p, /orcarouter-url/);
      assert.match(p, /https:\/\//);
      assert.match(p, /localhost|127\.0\.0\.0\/8|\[::1\]/);
    });
  }
});

describe("everything that sends the key asks it", () => {
  test("the proxy refuses with the judge's message", () => {
    assert.throws(
      () => createProxyServer({ upstreamUrl: "http://gateway.internal/v1/chat/completions" }),
      (e) => /orcarouter-url/.test(e.message) && /127\.0\.0\.0\/8/.test(e.message),
    );
    assert.doesNotThrow(() => createProxyServer({ upstreamUrl: "http://127.9.9.9:1/v1/chat/completions" }));
  });

  // 203.0.113.0/24 is TEST-NET-3: nothing answers there, so an attempt to send
  // would sit out the connect timeout. A refusal returns at once.
  const run = (script, args, env) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
        env: { ...process.env, ORCAROUTER_API_KEY: "k-secret", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => resolve({ status, out, err, ms: Date.now() - t0 }));
    });

  test("the settings fetch does not send the key to a plain-http gateway", async () => {
    const out = path.join(dir, "settings.json");
    const r = await run("settings.mjs", ["--url", "http://203.0.113.7/v1/chat/completions", "--repo", "a/b", "--out", out], {
      CR_SETTINGS_TIMEOUT_MS: "4000",
    });
    assert.equal(r.status, 0);
    assert.ok(r.ms < 2500, `took ${r.ms}ms — it tried to connect`);
    const got = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(got.status, "unavailable");
    assert.match(got.cause, /orcarouter-url/);
  });

  test("the run report does not send the key to a plain-http gateway", async () => {
    const result = path.join(dir, "result.json");
    fs.writeFileSync(result, JSON.stringify({ comments: [] }));
    const r = await run("report.mjs", [
      result, "--repo", "a/b", "--pr", "1", "--sha", "s", "--tier", "standard", "--gate", "pass",
      "--url", "http://203.0.113.7/v1/chat/completions",
    ]);
    assert.equal(r.status, 0);
    assert.ok(r.ms < 2500, `took ${r.ms}ms — it tried to connect`);
    assert.match(r.err, /orcarouter-url/);
  });
});

describe("the action fails at once, naming the input and the fix", () => {
  const settingsEnv = (url, enabled = "true") => {
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(out, "");
    return {
      out,
      env: {
        GATEWAY_URL_CHECK: path.join(ROOT, "scripts", "gateway-url.mjs"),
        SETTINGS_SCRIPT: path.join(ROOT, "scripts", "settings.mjs"),
        SETTINGS_ENABLED: enabled,
        ORCAROUTER_URL: url,
        ORCAROUTER_API_KEY: "k",
        CR_SETTINGS_TIMEOUT_MS: "300",
        REPO: "o/r",
        SETTINGS_JSON: path.join(dir, "s.json"),
        RUBRIC_FILE: path.join(dir, "r.md"),
        INPUT_FIX_FIRST: "P0,P1",
        INPUT_BLOCK_ON: "P0,P1",
        EVENT_NAME: "pull_request_target",
        IS_DRAFT: "false",
        AUTHOR_ASSOC: "OWNER",
        AUTO_REVIEW_AUTHORS: "",
        REPO_PRIVATE: "true",
        BRAND: "OrcaCode Review",
        GITHUB_OUTPUT: out,
      },
    };
  };

  for (const enabled of ["true", "false"]) {
    test(`a plain-http, non-loopback orcarouter-url fails the first step that reads it (settings: ${enabled})`, () => {
      const { env } = settingsEnv("http://gateway.internal/v1/chat/completions", enabled);
      const r = runBashStep(step("settings").run, { env });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /^::error::.*orcarouter-url.*https:\/\//m);
    });
  }

  test("a loopback gateway on plain http is fine", () => {
    const { env, out } = settingsEnv("http://127.0.0.1:9/v1/chat/completions", "false");
    const r = runBashStep(step("settings").run, { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(out, "utf8"), /decision=review/);
  });

  test("a step not handed the judge fails rather than skipping it (`node \"\"` would exit 0)", () => {
    const { env } = settingsEnv("http://gateway.internal/v1/chat/completions", "false");
    delete env.GATEWAY_URL_CHECK;
    const r = runBashStep(step("settings").run, { env });
    assert.notEqual(r.status, 0);
  });

  test("the step is handed the judge", () => {
    assert.equal(step("settings").env.GATEWAY_URL_CHECK, "${{ github.action_path }}/scripts/gateway-url.mjs");
  });
});
