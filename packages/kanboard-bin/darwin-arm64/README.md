# Kanboard binary: darwin-arm64

The `unipi-kanboard` binary for macOS arm64 (Apple silicon). [Kanboard](../../kanboard/README.md) uses it to read and write the board.

`@pi-unipi/kanboard-darwin-arm64` · part of [UniPi](../../../README.md)

- Rust target: `aarch64-apple-darwin`.
- File: `bin/unipi-kanboard`.
- npm installs this package only on macOS arm64 (Apple silicon). It is an optional dependency of `@pi-unipi/kanboard`.
- You do not install it yourself. `pi install npm:@pi-unipi/unipi` gets it.
- The CI workflow `.github/workflows/kanboard-binaries.yml` builds the binary. Git does not store it.
- To use a different binary, set `UNIPI_KANBOARD_BIN` to its path.
