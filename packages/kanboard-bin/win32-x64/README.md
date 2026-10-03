# Kanboard binary: win32-x64

The `unipi-kanboard` binary for Windows x64. [Kanboard](../../kanboard/README.md) uses it to read and write the board.

`@pi-unipi/kanboard-win32-x64` · part of [UniPi](../../../README.md)

- Rust target: `x86_64-pc-windows-msvc`.
- File: `bin/unipi-kanboard.exe`.
- npm installs this package only on Windows x64. It is an optional dependency of `@pi-unipi/kanboard`.
- You do not install it yourself. `pi install npm:@pi-unipi/unipi` gets it.
- The CI workflow `.github/workflows/kanboard-binaries.yml` builds the binary. Git does not store it.
- To use a different binary, set `UNIPI_KANBOARD_BIN` to its path.
