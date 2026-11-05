/**
 * Loads `.env` from the repo root into `process.env` for the local CLI scripts.
 *
 * These scripts are run by hand on a developer machine, and exporting shell
 * variables differs per platform (`export X=y` in bash, `$env:X = "y"` in
 * PowerShell, `set X=y` in cmd), which is an easy way to lose ten minutes. A
 * `.env` file works identically everywhere.
 *
 * Real environment variables always win, so CI or a one-off
 * `GOOGLE_ACCESS_TOKEN=... pnpm run probe:google` still overrides the file.
 *
 * This is for the local scripts only. The deployed Worker never reads `.env` —
 * it reads Cloudflare Workers Secrets. `.env` is gitignored.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(here, '..', '.env');

/**
 * Returns true when a `.env` was found and loaded.
 *
 * `process.loadEnvFile` (Node 20.12+) does the parsing, and by design does not
 * overwrite variables that are already set.
 */
export function loadEnv(): boolean {
  if (!existsSync(ENV_PATH)) return false;
  try {
    process.loadEnvFile(ENV_PATH);
    return true;
  } catch (err) {
    // A malformed .env should say so plainly rather than surface later as a
    // confusing "credentials not set" error.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Warning: could not read ${ENV_PATH} — ${reason}`);
    return false;
  }
}

/** Absolute path to the `.env` this module looks for, for use in messages. */
export const envPath = ENV_PATH;
