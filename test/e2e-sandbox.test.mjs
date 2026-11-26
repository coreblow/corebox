import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectIsolationBackend, executeSandboxed } from "../src/runner.mjs";

const cliPath = path.resolve("src/cli.mjs");

function runCli(args, { env = process.env, timeout = 15000 } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env,
    timeout,
  });
}

function hasBwrap() {
  if (os.platform() !== "linux") return false;
  const probe = spawnSync("which", ["bwrap"], { encoding: "utf8", timeout: 2000 });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

console.log("=== Running CoreBlow CoreBox E2E Sandbox Tests ===");

const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "corebox-e2e-ws-"));
const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "corebox-e2e-out-"));
const realWorkspace = fs.realpathSync(tmpWorkspace);
const realOutside = fs.realpathSync(tmpOutside);

try {
  // 1. CLI --detect & dry-run plan JSON output
  const detectRes = runCli(["--detect"]);
  assert.equal(detectRes.status, 0, `CLI --detect failed: ${detectRes.stderr}`);
  const detectJson = JSON.parse(detectRes.stdout);
  assert.equal(detectJson.available, true);
  assert.ok(["seatbelt", "bwrap", "docker", "process"].includes(detectJson.backend));

  const planRes = runCli([`--workspace=${realWorkspace}`, "--steps=check,test"]);
  assert.equal(planRes.status, 0, `CLI plan dry-run failed: ${planRes.stderr}`);
  const planJson = JSON.parse(planRes.stdout);
  assert.deepEqual(planJson.steps, ["check", "test"]);
  assert.deepEqual(planJson.commands, ["pnpm check", "pnpm test"]);
  assert.equal(planJson.isolationBackend.backend, detectJson.backend);
  console.log("✓ CLI --detect and plan JSON output verified.");

  // 2. CLI --exec exit-code propagation (0 and non-zero)
  const okExec = runCli([
    `--workspace=${realWorkspace}`,
    `--exec=${process.execPath} -e console.log('COREBOX_OK')`,
  ]);
  assert.equal(okExec.status, 0, `CLI --exec 0 failed: ${okExec.stderr}`);
  assert.match(okExec.stdout, /COREBOX_OK/);

  const failExec = runCli([
    `--workspace=${realWorkspace}`,
    `--exec=${process.execPath} -e process.exit(7)`,
  ]);
  assert.equal(failExec.status, 7, `Expected exit code 7, got ${failExec.status}`);
  console.log("✓ CLI exit-code propagation verified.");

  // 3. CLI timeout handling
  const timeoutExec = runCli([
    `--workspace=${realWorkspace}`,
    "--timeout=400",
    `--exec=${process.execPath} -e setInterval(()=>{},1000)`,
  ]);
  assert.notEqual(timeoutExec.status, 0, "Timed-out CLI --exec must exit non-zero");
  console.log("✓ CLI timeout handling verified.");

  // 4. Env allowlist scrubbing via CLI --exec
  const envLeakExec = runCli(
    [
      `--workspace=${realWorkspace}`,
      `--exec=${process.execPath} -e console.log(JSON.stringify({secret:process.env.COREBLOW_E2E_SECRET||null,aws:process.env.AWS_SECRET_ACCESS_KEY||null}))`,
    ],
    {
      env: {
        ...process.env,
        COREBLOW_E2E_SECRET: "leaked-secret",
        AWS_SECRET_ACCESS_KEY: "leaked-aws",
      },
    },
  );
  assert.equal(envLeakExec.status, 0, `CLI env check failed: ${envLeakExec.stderr}`);
  const envOut = JSON.parse(envLeakExec.stdout.trim());
  assert.equal(envOut.secret, null, "COREBLOW_* must be scrubbed");
  assert.equal(envOut.aws, null, "AWS_* must be scrubbed");
  console.log("✓ CLI environment scrubbing verified.");

  // 5. Real Linux bwrap E2E vs non-Linux graceful diagnostics
  if (hasBwrap()) {
    console.log("5. Running real Linux bwrap isolation E2E tests...");
    const hostTmpMarker = path.join("/tmp", `corebox-host-tmp-check-${process.pid}.txt`);
    try {
      fs.rmSync(hostTmpMarker, { force: true });
    } catch {}

    const bwrapScript = `
      const fs = require("fs");
      const path = require("path");
      // a) Workspace write must succeed
      fs.writeFileSync(path.join(${JSON.stringify(realWorkspace)}, "bwrap-ws.txt"), "ws-ok");
      // b) Isolated /tmp write must succeed inside bwrap without leaking to host /tmp
      fs.writeFileSync(${JSON.stringify(hostTmpMarker)}, "isolated-tmp-ok");
      // c) Host /tmp outside-workspace directory is shadowed by --tmpfs /tmp (ENOENT)
      let tmpOutsideErr = "NONE";
      try {
        fs.writeFileSync(path.join(${JSON.stringify(realOutside)}, "escape.txt"), "nope");
      } catch (err) {
        tmpOutsideErr = err.code || "ERR";
      }
      // d) Existing host path outside workspace is read-only (--ro-bind / /)
      let roOutsideErr = "NONE";
      try {
        fs.writeFileSync("/etc/corebox-escape-test.txt", "nope");
      } catch (err) {
        roOutsideErr = err.code || "ERR";
      }
      console.log(JSON.stringify({
        tmpOutsideErr,
        roOutsideErr,
        tmpInside: fs.readFileSync(${JSON.stringify(hostTmpMarker)}, "utf8"),
        secret: process.env.COREBLOW_BWRAP_SECRET || null,
        token: process.env.GITHUB_TOKEN || null,
      }));
    `;

    const prevSecret = process.env.COREBLOW_BWRAP_SECRET;
    const prevGhToken = process.env.GITHUB_TOKEN;
    process.env.COREBLOW_BWRAP_SECRET = "host-bwrap-secret";
    process.env.GITHUB_TOKEN = "host-gh-token";
    let bwrapRes;
    try {
      bwrapRes = await executeSandboxed(process.execPath, ["-e", bwrapScript], {
        workspace: realWorkspace,
        backend: "bwrap",
        timeoutMs: 10000,
      });
    } finally {
      if (prevSecret === undefined) delete process.env.COREBLOW_BWRAP_SECRET;
      else process.env.COREBLOW_BWRAP_SECRET = prevSecret;
      if (prevGhToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGhToken;
    }

    assert.equal(bwrapRes.exitCode, 0, `bwrap execution failed: ${bwrapRes.stderr}`);
    const parsed = JSON.parse(bwrapRes.stdout.trim());
    assert.equal(parsed.tmpOutsideErr, "ENOENT", `Expected /tmp outside dir to be shadowed (ENOENT), got: ${parsed.tmpOutsideErr}`);
    assert.ok(["EROFS", "EACCES", "EPERM"].includes(parsed.roOutsideErr), `Expected read-only failure on /etc, got: ${parsed.roOutsideErr}`);
    assert.equal(parsed.tmpInside, "isolated-tmp-ok");
    assert.equal(parsed.secret, null, "COREBLOW_BWRAP_SECRET must be scrubbed inside bwrap");
    assert.equal(parsed.token, null, "GITHUB_TOKEN must be scrubbed inside bwrap");
    assert.equal(fs.readFileSync(path.join(realWorkspace, "bwrap-ws.txt"), "utf8"), "ws-ok");
    assert.equal(fs.existsSync(path.join(realOutside, "escape.txt")), false, "Outside file must not exist on host");
    assert.equal(fs.existsSync(hostTmpMarker), false, "bwrap /tmp write must not leak to host /tmp");
    console.log("✓ Real Linux bwrap isolation (ro-bind, tmpfs /tmp, env scrub, stdout/exit) verified.");
  } else {
    console.log(`5. bwrap unavailable on ${os.platform()}; verifying graceful fallback diagnostics...`);
    const detected = detectIsolationBackend();
    assert.notEqual(detected.backend, "bwrap");
    await assert.rejects(
      () =>
        executeSandboxed(process.execPath, ["-e", "console.log('hi')"], {
          workspace: realWorkspace,
          backend: "bwrap",
          timeoutMs: 3000,
        }),
      (err) => err && (err.code === "ENOENT" || /bwrap/i.test(err.message)),
      "Explicit bwrap request on non-bwrap host should fail with clear ENOENT diagnostic",
    );
    console.log("✓ Graceful non-Linux bwrap diagnostic verified.");
  }
} finally {
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  fs.rmSync(tmpOutside, { recursive: true, force: true });
}

console.log("✅ All CoreBlow CoreBox E2E sandbox tests passed successfully.");
