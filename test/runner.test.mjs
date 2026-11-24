import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectIsolationBackend,
  executeSandboxed,
  generateSeatbeltProfile,
  runPlanInSandbox,
  scrubEnvironment,
} from "../src/runner.mjs";
import { createRunPlan } from "../src/plan.mjs";

console.log("=== Running CoreBlow CoreBox Sandbox Tests ===");

// 1. Environment scrubbing
console.log("1. Verifying environment scrubbing...");
process.env.COREBLOW_TEST_SECRET = "super-secret-token";
process.env.AWS_SECRET_KEY = "aws-secret";
process.env.SAFE_VAR = "safe-value";

const scrubbed = scrubEnvironment({ CUSTOM_FLAG: "true" }, ["SAFE_VAR"]);
assert.equal(scrubbed.COREBLOW_TEST_SECRET, undefined, "Sensitive token must be scrubbed");
assert.equal(scrubbed.AWS_SECRET_KEY, undefined, "AWS secret must be scrubbed");
assert.equal(scrubbed.SAFE_VAR, "safe-value", "Safe var must be preserved when in allowlist");
assert.equal(scrubbed.CUSTOM_FLAG, "true", "Explicit custom var must be included");
delete process.env.COREBLOW_TEST_SECRET;
delete process.env.AWS_SECRET_KEY;
delete process.env.SAFE_VAR;
console.log("✓ Environment scrubbing verified.");

// 2. Isolation backend detection
console.log("2. Verifying backend detection...");
const backendInfo = detectIsolationBackend();
assert.ok(backendInfo.available, "Isolation backend must be available");
assert.ok(["seatbelt", "bwrap", "docker", "process"].includes(backendInfo.backend));
console.log(`✓ Detected backend: ${backendInfo.name} (${backendInfo.backend})`);

// 3. Child process execution and workspace isolation
console.log("3. Verifying sandboxed command execution...");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "corebox-run-ws-"));
const outsideTmp = fs.mkdtempSync(path.join(os.tmpdir(), "corebox-run-outside-"));
const realWorkspace = fs.realpathSync(tmpDir);
const realOutside = fs.realpathSync(outsideTmp);

try {
  // 3a. Successful sandboxed execution & writing inside workspace
  const scriptContent = `
    const fs = require("fs");
    const path = require("path");
    fs.writeFileSync(path.join("${realWorkspace}", "inside.txt"), "written inside workspace");
    console.log("INSIDE_WRITE_SUCCESS");
  `;

  const runInside = await executeSandboxed(process.execPath, ["-e", scriptContent], {
    workspace: realWorkspace,
    timeoutMs: 10000,
  });

  assert.equal(runInside.exitCode, 0, `Command should succeed inside workspace: ${runInside.stderr}`);
  assert.ok(runInside.stdout.includes("INSIDE_WRITE_SUCCESS"));
  assert.ok(fs.existsSync(path.join(realWorkspace, "inside.txt")), "File should be created in workspace");
  assert.equal(fs.readFileSync(path.join(realWorkspace, "inside.txt"), "utf8"), "written inside workspace");
  console.log("✓ Allowed write inside workspace succeeded.");

  // 3b. If seatbelt is active on macOS, prove write outside workspace is blocked
  if (backendInfo.backend === "seatbelt") {
    console.log("3b. Testing macOS Seatbelt write denial outside workspace...");
    const outsideScript = `
      const fs = require("fs");
      const path = require("path");
      try {
        fs.writeFileSync(path.join("${realOutside}", "outside.txt"), "should fail");
        console.log("UNEXPECTED_OUTSIDE_WRITE_SUCCESS");
      } catch (err) {
        console.log("OUTSIDE_WRITE_DENIED:" + err.code);
      }
    `;

    const runOutside = await executeSandboxed(process.execPath, ["-e", outsideScript], {
      workspace: realWorkspace,
      backend: "seatbelt",
      timeoutMs: 10000,
    });

    assert.equal(runOutside.exitCode, 0);
    assert.ok(runOutside.stdout.includes("OUTSIDE_WRITE_DENIED:EPERM"), "Outside write must fail with EPERM under Seatbelt");
    assert.ok(!fs.existsSync(path.join(realOutside, "outside.txt")), "Outside file must not be created");
    console.log("✓ Seatbelt write restriction outside workspace verified (EPERM).");
  }

  // 4. Timeout enforcement
  console.log("4. Verifying timeout enforcement...");
  const hangingScript = `
    setInterval(() => {}, 1000);
  `;

  const timeoutRun = await executeSandboxed(process.execPath, ["-e", hangingScript], {
    workspace: realWorkspace,
    timeoutMs: 1500,
  });

  assert.equal(timeoutRun.timedOut, true, "Process should be flagged as timedOut");
  assert.notEqual(timeoutRun.exitCode, 0, "Hanging process should have non-zero exit code");
  console.log("✓ Timeout enforcement verified.");

  // 5. Multi-step plan execution
  console.log("5. Verifying sandboxed plan runner...");
  const plan = {
    workspace: realWorkspace,
    commands: [
      `${process.execPath} -e "console.log('step 1 ok')"`,
      `${process.execPath} -e "console.log('step 2 ok')"`,
    ],
  };

  const planRes = await runPlanInSandbox(plan, { workspace: realWorkspace, timeoutMs: 5000 });
  assert.equal(planRes.success, true);
  assert.equal(planRes.results.length, 2);
  assert.equal(planRes.results[0].exitCode, 0);
  assert.equal(planRes.results[1].exitCode, 0);
  console.log("✓ Sandboxed plan execution verified.");

} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(outsideTmp, { recursive: true, force: true }); } catch {}
}

console.log("✅ All CoreBlow CoreBox runner tests passed successfully.");
