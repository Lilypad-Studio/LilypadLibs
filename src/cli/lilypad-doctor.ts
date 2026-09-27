#!/usr/bin/env node
/**
 * `npx lilypad-doctor`: checks the database against a config; `npx lilypad-doctor init` creates a
 * config file. See `runLilypadDoctorCli` for the options, or run it with `--help`.
 */
import { runLilypadDoctorCli } from '@/cli/LilypadDoctorCli';

void runLilypadDoctorCli(process.argv.slice(2), process.env, console).then((code) => {
  process.exitCode = code;
});
