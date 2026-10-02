# src/cli

The `lilypad-doctor` command:

- `lilypad-doctor.ts` is the entry, with its `#!/usr/bin/env node`, which rolldown keeps.
- `LilypadDoctorCli.ts` parses the arguments with `node:util` `parseArgs`: `--config`, `--url`, else the variable `--url-env` (default `DATABASE_URL`) from the environment, then from the `--env-file` files (`util.parseEnv`, never written to `process.env`), `--sql`, `--json`, `--fail-on-warnings` (exit 1 on warnings too); exit codes 0/1/2; unit-tested with an injected `run`, `load` and `readEnv`. Node.js 22 checks that a `--env-file` given to the script exists, even after the script name: a missing one exits with 9 before the CLI runs.
- `lilypad-doctor init [--config <name|path>] [--empty] [--force]` (`LilypadInitCli.ts`, dispatched on `argv[0] === 'init'`, no database) writes a config from `lilypadDbConfigTemplate.ts` (TypeScript for `.ts`/`.mts`, JavaScript otherwise); it refuses when a file of the same config exists; `--force` overwrites only the file it creates, never next to another file of the same config (the loader would refuse both). Its tests inject the file system (`init` dependencies) and import every template variant (the package import replaced by `src/entries/schema.ts`), so a template that stops being a valid config fails them.
