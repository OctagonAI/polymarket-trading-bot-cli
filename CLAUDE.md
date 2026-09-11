# CLAUDE.md

## Workflow

- Always commit and push after each change.
- When a command's flags or signature changes, update ALL of these:
  - `src/commands/parse-args.ts` — flag parsing and `ParsedArgs` interface
  - `src/commands/help.ts` — detailed help topic and overview section
  - `src/commands/index.ts` — TUI slash command handler and `defaultArgs()`
  - `src/commands/dispatch.ts` — CLI dispatch block
  - `src/cli.ts` — autocomplete `slashCommands` array
  - `src/components/intro.ts` — welcome screen command list
  - `README.md` — commands table, flags table, and examples
  - `src/__tests__/e2e.test.ts` — `makeParsedArgs()` defaults
  - `src/gateway/commands/handler.ts` — `makeArgs()` defaults

- Adding a **non-optional** `ParsedArgs` field breaks every copy of the defaults list.
  There are seven, not just the two listed above — `rg -l 'parseErrors: \[\],' src` finds
  them all, and `bun run typecheck` names any that were missed.
- A new setup-wizard step also touches `src/setup/wizard.ts`, where the `Step N/M` titles
  are hard-coded in three parallel switches (`getTitle`, `getDescription`, `getFooter`).
