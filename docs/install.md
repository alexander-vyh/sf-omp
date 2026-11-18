---
title: Install sf-omp
description: Install Node.js, the repository-local OMP runtime, Salesforce CLI, and the managed Salesforce skill library on macOS.
---

# Install sf-omp

sf-omp runs every SF Pi extension inside a repository-local
[OMP](https://github.com/can1357/oh-my-pi) runtime. OMP and Bun are pinned
dependencies of this checkout; nothing is installed globally. Follow this
one-time setup in order.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js `>=22.19` and the npm bundled with it; sf-omp declares
  no separate npm floor
- a Salesforce CLI installation

## 1. Install Node.js and npm

Install [Node.js](https://nodejs.org/) **22.19 or newer** (24 recommended) and
verify the bundled npm client:

```bash
node --version
npm --version
```

## 2. Clone and install

```bash
git clone https://github.com/alexander-vyh/sf-omp.git
cd sf-omp
npm ci
```

`npm ci` installs the pinned OMP and Bun into `node_modules` and applies one
version-checked compatibility patch to that local copy only.

## 3. Install or update Salesforce CLI

```bash
npm install --global @salesforce/cli@latest
sf --version
```

See the official
[Salesforce CLI installation guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_install_cli.htm)
for verification details.

## 4. Start OMP and verify the installation

From this checkout:

```bash
npm start
```

With the direnv shell hook enabled, `direnv allow .` once at the checkout root
puts `tools/bin` first on PATH. Here and in subdirectories, `omp` then runs this
checkout's pinned Bun and OMP with the current working directory and arguments;
leaving the checkout restores the global `omp`.

From an existing Salesforce project, keep that project as the working directory:

```bash
cd /path/to/your/salesforce-project
/path/to/sf-omp/node_modules/bun/bin/bun.exe /path/to/sf-omp/scripts/omp.ts
```

Then enter:

```text
/sf-pi doctor
```

### Resume an existing session

Exit the other OMP process first; never open the same session in two processes.
Because sf-omp has its own session directory, use the original session file's
absolute path rather than `--continue` to resume a session from global OMP:

```bash
/path/to/sf-omp/node_modules/bun/bin/bun.exe \
  /path/to/sf-omp/scripts/omp.ts --resume /absolute/path/to/session.jsonl
```

This checkout pins OMP 18.22.0 and matching native packages. Session-rendering
archives are not guaranteed to be backward compatible: an older reader can fail
with `unsupported native syntax archive version` during history replay even
when all extensions load. Align the runtime with the session writer using the
checkout's reviewed upgrade and `npm ci`; do not edit or delete session history
to bypass that error.

## 5. Install Salesforce skills and language servers

```text
/sf-skills defaults install global
/sf-skills summary
/sf-lsp install
/sf-lsp doctor
```

Here `global` means this launcher's isolated `.runtime/omp/agent`, not `~/.omp`.
Java-based tooling uses a JDK extracted to `.runtime/toolchains/java` (see the
root README).

A successful setup has:

- `/sf-pi doctor` reporting no blocking installation problem;
- `sf --version` printing the installed Salesforce CLI version; and
- `/sf-skills summary` showing the managed Salesforce skills.

<details>
<summary><strong>Advanced setup and manual updates</strong></summary>

### Terminal font

If terminal glyphs appear as `?`, run:

```text
/sf-setup-fonts
```

Then select **MesloLGM Nerd Font Mono** in your terminal and reopen it.

### Manual updates

```bash
git pull
npm ci
npm install --global @salesforce/cli@latest
```

Restart OMP, then verify with `/sf-pi doctor`.

### Platform notes

sf-omp supports macOS only. The required `validate` CI job runs on macOS and
proves the type check, full unit suite, native OMP smoke, shared-auth smoke, and
extension parity on every push and pull request.

</details>

## Maintained support evidence

| Claim             | Maintained proof                                                                     |
| ----------------- | ------------------------------------------------------------------------------------ |
| Node.js `>=22.19` | `package.json` engines, preinstall check, and doctor diagnostics                     |
| OMP runtime       | exact pinned dependency, `scripts/omp-runtime.ts` version check, and the parity gate |
| npm client        | no independent engine/package-manager floor; CI uses the npm bundled by Node 24      |
| Operating system  | macOS only; the required `validate` job runs on Apple Silicon (`macos-15`)           |

## Next step

Continue with the [Quickstart](./quickstart.md).
