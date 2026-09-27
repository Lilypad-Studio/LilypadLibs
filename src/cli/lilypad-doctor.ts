#!/usr/bin/env node
/**
 * `npx lilypad-doctor`: checks that the database has what the `LilypadDbCache` instances need.
 * See `runLilypadDoctorCli` for the options, or run it with `--help`.
 */
import { runLilypadDoctorCli } from '@/cli/LilypadDoctorCli';

void runLilypadDoctorCli(process.argv.slice(2), process.env, console).then((code) => {
  process.exitCode = code;
});
