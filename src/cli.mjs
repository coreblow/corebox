#!/usr/bin/env node
import { createRunPlan } from "./plan.mjs";
import { detectIsolationBackend, executeSandboxed, runPlanInSandbox } from "./runner.mjs";

function printUsage() {
  console.log(`CoreBlow CoreBox - Clean-Room Validation Runner

Usage:
  corebox [options]

Options:
  --steps=<s1,s2,...>     Execution steps (default: install,check,test)
  --workspace=<path>      Workspace directory (default: current directory)
  --backend=<auto|seatbelt|bwrap|docker|process> Isolation backend
  --run                   Execute the plan in the sandbox
  --exec="<cmd>"          Execute a single command sandboxed
  --timeout=<ms>          Timeout in milliseconds (default: 30000)
  --detect                Print detected isolation backend and exit
  --help                  Show this help message
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.includes("--detect")) {
    const info = detectIsolationBackend();
    console.log(JSON.stringify(info, null, 2));
    process.exit(0);
  }

  const stepsArg = args.find((a) => a.startsWith("--steps="));
  const wsArg = args.find((a) => a.startsWith("--workspace="));
  const backendArg = args.find((a) => a.startsWith("--backend="));
  const timeoutArg = args.find((a) => a.startsWith("--timeout="));
  const execArg = args.find((a) => a.startsWith("--exec="));

  const steps = stepsArg ? stepsArg.slice("--steps=".length).split(",").filter(Boolean) : undefined;
  const workspace = wsArg ? wsArg.slice("--workspace=".length) : process.cwd();
  const backend = backendArg ? backendArg.slice("--backend=".length) : "auto";
  const timeoutMs = timeoutArg ? parseInt(timeoutArg.slice("--timeout=".length), 10) : 30000;

  if (execArg) {
    const rawCmd = execArg.slice("--exec=".length);
    const parts = rawCmd.split(/\s+/);
    const res = await executeSandboxed(parts[0], parts.slice(1), {
      workspace,
      backend,
      timeoutMs,
    });
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  }

  const plan = createRunPlan({ steps, workspace });

  if (args.includes("--run")) {
    const res = await runPlanInSandbox(plan, { backend, timeoutMs, workspace });
    for (const stepRes of res.results) {
      console.log(`[corebox] ${stepRes.command} -> exit code ${stepRes.exitCode} (${stepRes.durationMs}ms)`);
      if (stepRes.stderr && stepRes.exitCode !== 0) {
        process.stderr.write(stepRes.stderr);
      }
    }
    process.exit(res.success ? 0 : 1);
  }

  // Dry run / print plan
  const detected = detectIsolationBackend();
  console.log(JSON.stringify({ ...plan, isolationBackend: detected }, null, 2));
}

main().catch((err) => {
  console.error(`[corebox] error:`, err.message);
  process.exit(1);
});
