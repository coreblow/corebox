import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Standard sensitive environment variable patterns stripped by clean-room runner.
 */
const SENSITIVE_ENV_PATTERNS = [
  /TOKEN/i,
  /KEY/i,
  /SECRET/i,
  /AUTH/i,
  /PASS/i,
  /CRED/i,
  /COOKIE/i,
  /SESSION/i,
  /^AWS_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^COREBLOW_/i,
  /^NPM_TOKEN/i,
];

/**
 * Detects the available sandboxing isolation backend on the host system.
 */
export function detectIsolationBackend() {
  const platform = os.platform();

  if (platform === "darwin") {
    try {
      const probe = spawnSync("sandbox-exec", ["-p", "(version 1) (allow default)", "true"], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (probe.status === 0) {
        return { backend: "seatbelt", available: true, name: "macOS Seatbelt (sandbox-exec)" };
      }
    } catch {
      // not available
    }
  }

  if (platform === "linux") {
    try {
      const probe = spawnSync("which", ["bwrap"], { encoding: "utf8", timeout: 2000 });
      if (probe.status === 0 && probe.stdout.trim()) {
        return { backend: "bwrap", available: true, name: "Linux Bubblewrap (bwrap)" };
      }
    } catch {
      // not available
    }
  }

  try {
    const probe = spawnSync("docker", ["--version"], { encoding: "utf8", timeout: 2000 });
    if (probe.status === 0) {
      return { backend: "docker", available: true, name: "Docker Container Isolation" };
    }
  } catch {
    // not available
  }

  return { backend: "process", available: true, name: "Process Isolation (Scrubbed Env & Timeout)" };
}

/**
 * Scrubs hostile or credential-leaking environment variables from child process execution.
 */
export function scrubEnvironment(extraEnv = {}, allowList = []) {
  const clean = {};
  const allowedKeys = new Set([
    "PATH",
    "NODE_PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "HOME",
    "USER",
    "SHELL",
    "CI",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT",
    ...allowList,
  ]);

  for (const [k, v] of Object.entries(process.env)) {
    if (!allowedKeys.has(k)) continue;
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(k));
    if (!isSensitive) {
      clean[k] = v;
    }
  }

  for (const [k, v] of Object.entries(extraEnv)) {
    clean[k] = v;
  }

  return clean;
}

/**
 * Generates macOS Seatbelt SBPL profile restricting writes strictly to the given workspace.
 */
export function generateSeatbeltProfile(workspacePath) {
  const realWs = fs.existsSync(workspacePath) ? fs.realpathSync(workspacePath) : path.resolve(workspacePath);
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${realWs}"))
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/empty"))
`;
}

/**
 * Executes a command inside the selected sandbox isolation environment.
 */
export function executeSandboxed(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const workspace = options.workspace || process.cwd();
    const realWs = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
    const timeoutMs = options.timeoutMs ?? 30000;
    const requestedBackend = options.backend || "auto";
    const detected = detectIsolationBackend();
    const backend = requestedBackend === "auto" ? detected.backend : requestedBackend;

    const env = scrubEnvironment(options.env || {}, options.allowedEnv || []);
    let bin = command;
    let spawnArgs = [...args];

    if (backend === "seatbelt") {
      const profile = generateSeatbeltProfile(realWs);
      bin = "sandbox-exec";
      spawnArgs = ["-p", profile, command, ...args];
    } else if (backend === "bwrap") {
      bin = "bwrap";
      spawnArgs = [
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--bind", realWs, realWs,
        "--chdir", realWs,
        "--unshare-all",
        "--share-net",
        command,
        ...args,
      ];
    } else if (backend === "docker") {
      bin = "docker";
      spawnArgs = [
        "run",
        "--rm",
        "-i",
        "-v", `${realWs}:/workspace:rw`,
        "-w", "/workspace",
        "--read-only",
        "--tmpfs", "/tmp",
        options.dockerImage || "node:22-alpine",
        command,
        ...args,
      ];
    }

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let child;
    try {
      child = spawn(bin, spawnArgs, {
        cwd: realWs,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
          }, 1000);
        } catch {}
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs,
        backend,
      });
    });
  });
}

/**
 * Splits a command line string into an executable and arguments, respecting quotes.
 */
export function parseCommandArgs(cmdStr) {
  const tokens = [];
  let current = "";
  let inQuotes = null;
  for (let i = 0; i < cmdStr.length; i++) {
    const c = cmdStr[i];
    if (inQuotes) {
      if (c === inQuotes) inQuotes = null;
      else current += c;
    } else if (c === "\"" || c === "'") {
      inQuotes = c;
    } else if (/\s/.test(c)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Runs a multi-step execution plan sequentially inside a sandboxed workspace.
 */
export async function runPlanInSandbox(plan, options = {}) {
  const results = [];
  const workspace = plan.workspace || options.workspace || process.cwd();

  for (const cmdStr of plan.commands) {
    const tokens = parseCommandArgs(cmdStr);
    const cmd = tokens[0];
    const args = tokens.slice(1);

    const res = await executeSandboxed(cmd, args, {
      ...options,
      workspace,
    });
    results.push({ command: cmdStr, ...res });

    if (res.exitCode !== 0 && !options.continueOnError) {
      return {
        success: false,
        failedStep: cmdStr,
        results,
      };
    }
  }

  return {
    success: results.every((r) => r.exitCode === 0),
    results,
  };
}
