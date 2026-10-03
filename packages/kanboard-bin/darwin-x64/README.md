# Kanboard binary: darwin-x64

The `unipi-kanboard` binary for macOS x64 (Intel). [Kanboard](../../kanboard/README.md) uses it to read and write the board.

`@pi-unipi/kanboard-darwin-x64` · part of [UniPi](../../../README.md)

- Rust target: `x86_64-apple-darwin`.
- File: `bin/unipi-kanboard`.
- npm installs this package only on macOS x64 (Intel). It is an optional dependency of `@pi-unipi/kanboard`.
- You do not install it yourself. `pi install npm:@pi-unipi/unipi` gets it.
- The CI workflow `.github/workflows/kanboard-binaries.yml` builds the binary. Git does not store it.
- To use a different binary, set `UNIPI_KANBOARD_BIN` to its path.
