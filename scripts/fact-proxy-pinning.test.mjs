// fact-proxy.mjs: where a request may go, and whose credential it carries.
//
// The proxy is the one process in the job that holds the real OrcaRouter key
// (the engine that reads the PR checkout gets a placeholder). That makes two
// things load-bearing:
//
//   1. The request target is PINNED. Only an origin-form path (`/v1/...`) equal
//      to the configured endpoint's path is forwarded, and only to the one
//      configured origin. Before this, `new URL(req.url, upstream)` resolved an
//      absolute-form target (`http://elsewhere/...`), a scheme-relative one
//      (`//elsewhere/...`) or a backslash variant to ANOTHER host and sent the
//      client's Authorization there.
//   2. The upstream is https. Plain http is accepted only for a loopback host,
//      which is what these tests use.
//
// And the key is the proxy's own: it comes from CR_UPSTREAM_KEY_FILE (read,
// then unlinked before the proxy announces PROXY_URL — so before the engine can
// start), never from the client, and replaces whatever Authorization the client
// sent.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createProxyServer } from "./fact-proxy.mjs";

const PROXY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "fact-proxy.mjs");
let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "fact-proxy-pin-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function recorder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
}

async function proxyFor(upstreamPort, extra = {}) {
  const server = createProxyServer({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    sleep: () => Promise.resolve(),
    ...extra,
  });
  const port = await listen(server);
  return { port, close: () => new Promise((r) => server.close(r)) };
}

function send(port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", (e) => resolve({ status: null, error: e.message }));
    req.end("{}");
  });
}

describe("the request target is pinned to the configured origin and path", () => {
  for (const [label, target] of [
    ["absolute-form to another host", (p) => `http://127.0.0.1:${p}/v1/chat/completions`],
    ["scheme-relative //host", (p) => `//127.0.0.1:${p}/v1/chat/completions`],
    ["backslash //host variant", (p) => `/\\127.0.0.1:${p}/v1/chat/completions`],
  ]) {
    test(`${label}: never forwarded, the client's Authorization goes nowhere`, async () => {
      const upstream = await recorder();
      const elsewhere = await recorder();
      const proxy = await proxyFor(upstream.port);
      try {
        const r = await send(proxy.port, target(elsewhere.port), { authorization: "Bearer client-secret" });
        assert.notEqual(r.status, 200);
        assert.equal(elsewhere.seen.length, 0, "the request reached a host other than the configured one");
        assert.equal(upstream.seen.length, 0, "a refused target must not be forwarded anywhere");
      } finally {
        await proxy.close();
        await upstream.close();
        await elsewhere.close();
      }
    });
  }

  test("a path other than the configured endpoint is refused, not forwarded", async () => {
    const upstream = await recorder();
    const proxy = await proxyFor(upstream.port);
    try {
      const r = await send(proxy.port, "/api/code_review/settings?repo=a/b");
      assert.equal(r.status, 404);
      assert.equal(upstream.seen.length, 0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("the configured path is forwarded, to the configured origin (query kept)", async () => {
    const upstream = await recorder();
    const proxy = await proxyFor(upstream.port);
    try {
      const r = await send(proxy.port, "/v1/chat/completions?x=1");
      assert.equal(r.status, 200);
      assert.equal(upstream.seen.length, 1);
      assert.equal(upstream.seen[0].url, "/v1/chat/completions?x=1");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("the upstream must be https (http only for loopback)", () => {
  test("a plain-http, non-loopback upstream is refused", () => {
    assert.throws(
      () => createProxyServer({ upstreamUrl: "http://api.orcarouter.ai/v1/chat/completions" }),
      /https/i,
    );
  });

  test("https is accepted", () => {
    assert.doesNotThrow(() => createProxyServer({ upstreamUrl: "https://api.orcarouter.ai/v1/chat/completions" }));
  });

  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    test(`http to loopback ${host} is accepted (local test upstreams)`, () => {
      assert.doesNotThrow(() => createProxyServer({ upstreamUrl: `http://${host}:8080/v1/chat/completions` }));
    });
  }

  test("a non-http(s) upstream is refused", () => {
    assert.throws(() => createProxyServer({ upstreamUrl: "file:///etc/passwd" }));
  });
});

describe("the proxy injects its own key", () => {
  test("upstreamKey replaces the client's Authorization and drops x-api-key", async () => {
    const upstream = await recorder();
    const proxy = await proxyFor(upstream.port, { upstreamKey: "real-orcarouter-key" });
    try {
      const r = await send(proxy.port, "/v1/chat/completions", {
        authorization: "Bearer placeholder",
        "x-api-key": "placeholder",
      });
      assert.equal(r.status, 200);
      assert.equal(upstream.seen[0].headers.authorization, "Bearer real-orcarouter-key");
      assert.equal(upstream.seen[0].headers["x-api-key"], undefined);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test("the CLI reads CR_UPSTREAM_KEY_FILE, unlinks it before announcing PROXY_URL, and injects it", async () => {
    const upstream = await recorder();
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "real-key-from-file\n", { mode: 0o600 });
    const child = spawn(process.execPath, [PROXY_SCRIPT], {
      env: {
        ...process.env,
        ORCAROUTER_URL: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
        CR_UPSTREAM_KEY_FILE: keyFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error("no PROXY_URL within 5s")), 5000);
        child.stdout.on("data", (c) => {
          out += c;
          const m = out.match(/^PROXY_URL=(.+)$/m);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on("exit", (code) => reject(new Error(`proxy exited early (${code})`)));
      });
      assert.equal(existsSync(keyFile), false, "the key file must be gone once PROXY_URL is announced");
      const u = new URL(url);
      const r = await send(Number(u.port), u.pathname, { authorization: "Bearer placeholder" });
      assert.equal(r.status, 200);
      assert.equal(upstream.seen[0].headers.authorization, "Bearer real-key-from-file");
    } finally {
      child.kill();
      await upstream.close();
    }
  });

  test("the CLI refuses to start when CR_UPSTREAM_KEY_FILE is set but unreadable", async () => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [PROXY_SCRIPT], {
        env: {
          ...process.env,
          ORCAROUTER_URL: "http://127.0.0.1:9/v1/chat/completions",
          CR_UPSTREAM_KEY_FILE: join(dir, "no-such-key"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve("still running");
      }, 5000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.notEqual(code, 0);
    assert.notEqual(code, "still running");
  });

  test("the CLI refuses a plain-http non-loopback ORCAROUTER_URL", async () => {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [PROXY_SCRIPT], {
        env: { ...process.env, ORCAROUTER_URL: "http://example.com/v1/chat/completions" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve("still running");
      }, 5000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.notEqual(code, 0);
    assert.notEqual(code, "still running");
  });
});
