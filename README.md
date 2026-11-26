# CoreBox

Clean-room workspace validation and sandboxed command runner for CoreBlow.

## Overview

CoreBox is part of the CoreBlow public repository family. It provides OS-level isolated execution for validation plans, testing suites, and workspace commands with strict filesystem write boundaries, environment scrubbing, and timeout enforcement.

This repository follows the same ecosystem split that CoreBlow uses to keep release surfaces small, auditable, and independently governed.

## Repository Role

- Status: Active
- Phase: 2
- Priority: ci-infra
- Kind: runner
- Family: CoreBlow public repository family
- Branding: CoreBlow

## Features

- **Multi-Backend Isolation**: Automatically detects and leverages:
  - **macOS Seatbelt (`sandbox-exec`)**: Hardware-enforced kernel sandbox restricting writes strictly to the specified workspace directory.
  - **Linux Bubblewrap (`bwrap`)**: Unprivileged user-namespace containerization with read-only root mount and writable workspace bind.
  - **Docker Container**: Ephemeral containerized runs with `--read-only` root filesystem.
  - **Process Isolation**: Clean process runner fallback with env scrubbing and timeout supervision.
- **Strict Write Containment**: Writes outside the workspace are blocked with `EPERM` (macOS Seatbelt) or `EROFS`/read-only filesystem errors (Linux `bwrap` with `--ro-bind / /` and isolated `--tmpfs /tmp`).
- **Credential Scrubbing**: Strips sensitive authentication tokens, API keys, and cloud secrets (`TOKEN`, `KEY`, `SECRET`, `AUTH`, `AWS_*`, `GITHUB_*`, `COREBLOW_*`) from child process environments.
- **Deterministic Timeouts**: Supervised execution terminating runaway or hanging child processes.

## Usage

### Command Line Interface

```sh
# Detect available isolation backend
node src/cli.mjs --detect

# Run default plan (install, check, test) inside sandbox
node src/cli.mjs --workspace=/path/to/project --run

# Execute an arbitrary command sandboxed
node src/cli.mjs --workspace=/path/to/project --exec="pnpm test" --timeout=60000

# Specify isolation backend explicitly
node src/cli.mjs --backend=seatbelt --exec="node -e 'console.log(process.cwd())'"
```

### Programmatic Usage

```javascript
import { executeSandboxed, runPlanInSandbox, createRunPlan } from "@coreblow/corebox";

// Execute command in sandboxed workspace
const result = await executeSandboxed("node", ["test/suite.js"], {
  workspace: "./my-project",
  timeoutMs: 30000,
});
console.log(result.exitCode, result.stdout);

// Run a multi-step plan
const plan = createRunPlan({ steps: ["install", "check", "test"], workspace: "./my-project" });
const outcome = await runPlanInSandbox(plan);
console.log("Plan succeeded:", outcome.success);
```

## Development

### Test

```sh
npm test
```

## Release Policy

Do not publish packages, tags, installers, or release artifacts from this repository without explicit CoreBlow release approval.

Version changes must follow the coordinated CoreBlow release plan.

## Links

- [CoreBlow](https://github.com/coreblow/coreblow)
- [Documentation](https://docs.coreblow.com)
- [Website](https://coreblow.com)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
