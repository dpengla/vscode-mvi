# MVI Native

`MVI Native` is a local VS Code extension that drives the real editor with mvi-style modal controls.

## What It Does

- Keeps editing inside the native VS Code text editor
- Provides normal, insert, visual, visual-line, and visual-block modes
- Uses native decorations for cursor-line, block cursor, visual-line, and spell rendering
- Supports motions, operators, search, marks, registers, macros, ex commands, and external `aspell` suggestions via `z=`

## Running Locally

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host window, open a file.
4. Run `MVI: Enable Native Editor Mode`.

## Packaging A VSIX

1. Install the packaging tool:

```bash
npm install -g @vscode/vsce
```

2. From this folder, build a VSIX:

```bash
vsce package
```

3. In VS Code, run `Extensions: Install from VSIX...` and choose the generated file.

## Key Commands

- `MVI: Enable Native Editor Mode`
- `MVI: Disable Native Editor Mode`
- `Esc` / `Ctrl+[`
- `Ctrl+V` / `Ctrl+Q` for visual block
- On macOS, `Cmd+V` also enters visual block while MVI mode is active

## Notes

- `:set spell`, `:set nospell`, and `z=` use external `aspell`
- Current `aspell` path in the extension is `/opt/homebrew/bin/aspell`
- This extension is currently tailored to the local workspace rather than marketplace publishing
# vscode-mvi
