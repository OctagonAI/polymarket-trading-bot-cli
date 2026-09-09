#!/usr/bin/env bun
// Side-effect import: env.ts performs the dotenv load against the canonical
// ENV_PATH (~/.polymarket-bot/.env or CWD .env). Must run before any other module
// reads process.env.
import './utils/env.js';
import { runCli } from './cli.js';
import { parseArgs } from './commands/parse-args.js';
import { dispatch } from './commands/dispatch.js';
import { initTelemetry, trackEvent, shutdownTelemetry } from './utils/telemetry.js';
import packageJson from '../package.json';

// --version / --help are handled before anything else: they are flags rather
// than subcommands, so parseArgs() would fall through to `chat` and open the
// TUI instead of printing and exiting.
const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  console.log(packageJson.version);
  process.exit(0);
}
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  const { buildHelp } = await import('./commands/help.js');
  const rendered = buildHelp('cli');
  console.log('text' in rendered ? rendered.text : rendered.error);
  process.exit(0);
}

const parsed = parseArgs();

await initTelemetry();
trackEvent('app_start', {
  mode: parsed.subcommand === 'chat' || parsed.subcommand === 'init' ? 'tui' : 'cli',
  command: parsed.subcommand,
  version: packageJson.version,
});

if (parsed.subcommand === 'chat') {
  await runCli();
  await shutdownTelemetry();
} else if (parsed.subcommand === 'init') {
  await runCli({ forceSetup: true });
  await shutdownTelemetry();
} else {
  await dispatch(parsed);
  await shutdownTelemetry();
}
