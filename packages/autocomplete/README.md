# @pi-unipi/command-enchantment

Enhanced autocomplete for Unipi commands. It wraps Pi's base autocomplete provider and makes `/unipi:*` suggestions easier to scan with package grouping, stable sorting, short descriptions, and package colors.

## Commands

Command Enchantment has no user commands. It improves the editor autocomplete experience automatically when the package is installed.

## What It Does

- Groups `/unipi:*` commands by package so workflow, memory, web, footer, and other commands are visually distinct.
- Sorts matches in predictable tiers: exact Unipi matches first, then other Unipi matches, then system commands.
- Preserves dynamic argument completions from command providers, including workflow document and worktree suggestions.
- Ships an audit test that checks registered Unipi commands are represented in the autocomplete registry and have descriptions.

## Development Checks

Run the registry audit before releases:

```bash
npm --workspace packages/autocomplete test -- src/__tests__/command-registry.audit.test.ts
```

Run all autocomplete tests:

```bash
npm --workspace packages/autocomplete test
```

## Configuration

Autocomplete enhancement is enabled by default. The package stores its toggle in the Unipi config and can be disabled by setting `autocompleteEnhanced` to `false`.

## License

MIT
