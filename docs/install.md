---
title: Install sf-omp
description: Install native OMP, Node.js, Salesforce CLI, and the managed Salesforce skill library on macOS.
---

# Install sf-omp

sf-omp runs every SF Pi extension inside the same native
[OMP](https://github.com/can1357/oh-my-pi) installation you use outside the
checkout, with separate Salesforce settings, extensions, and session storage.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js `>=22.19` and the npm bundled with it; sf-omp declares
  no separate npm floor
- native [OMP](https://omp.sh/) `>=19.2.1` on PATH; verify with `omp --version`
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

`npm ci` installs the local dependencies for the global-auth bridge, extensions,
and reproducible compatibility tests. It does not install the launcher’s OMP binary.

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
puts `tools/bin` first on PATH. Here and in subdirectories, `omp` invokes native
OMP with Salesforce extensions and settings, keeping the current working
directory and arguments. Leaving the checkout restores plain native invocation.

From an existing Salesforce project, keep that project as the working directory:

```bash
cd /path/to/your/salesforce-project
/path/to/sf-omp/tools/bin/omp
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
/path/to/sf-omp/tools/bin/omp --resume /absolute/path/to/session.jsonl
```

An older OMP reader can fail with `unsupported native syntax archive version`
during history replay even when all extensions load. Use `omp update` to align
the installed binary with the session writer. Do not edit or delete session
history to bypass that error.

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

Run `omp update` (or `omp update --check` for a read-only check) inside or
outside sf-omp. It manages the same native binary either way and does not
read or modify the Git working tree. Update the extension checkout and
Salesforce CLI separately:

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

| Claim             | Maintained proof                                                                |
| ----------------- | ------------------------------------------------------------------------------- |
| Node.js `>=22.19` | `package.json` engines, preinstall check, and doctor diagnostics                |
| OMP runtime       | native launcher; exact 19.2.1 compatibility checks in smoke and parity          |
| npm client        | no independent engine/package-manager floor; CI uses the npm bundled by Node 24 |
| Operating system  | macOS only; the required `validate` job runs on Apple Silicon (`macos-15`)      |

## Next step

Continue with the [Quickstart](./quickstart.md).
