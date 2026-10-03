# Kanboard binary: linux-arm64

The `unipi-kanboard` binary for Linux arm64. [Kanboard](../../kanboard/README.md) uses it to read and write the board.

`@pi-unipi/kanboard-linux-arm64` · part of [UniPi](../../../README.md)

- Rust target: `aarch64-unknown-linux-musl`. The binary is static (musl).
- File: `bin/unipi-kanboard`.
- npm installs this package only on Linux arm64. It is an optional dependency of `@pi-unipi/kanboard`.
- You do not install it yourself. `pi install npm:@pi-unipi/unipi` gets it.
- The CI workflow `.github/workflows/kanboard-binaries.yml` builds the binary. Git does not store it.
- To use a different binary, set `UNIPI_KANBOARD_BIN` to its path.
