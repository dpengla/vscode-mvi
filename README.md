# MVI

`MVI` is a local VS Code extension with mvi-style modal controls.

## What It Does

- Keeps editing inside the VS Code text editor
- Provides normal, insert, visual, visual-line, and visual-block modes
- Uses VS Code decorations for cursor-line, block cursor, visual-line, and spell rendering
- Supports motions, operators, search, marks, registers, macros, ex commands, and external `aspell` suggestions via `z=`

## Running Locally

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host window, open a file.
4. MVI will enable automatically on startup by default.
5. To opt out, set `mvijs.autoEnable` to `false`.

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

- `MVI: Enable`
- `MVI: Disable`
- `mvijs.autoEnable` toggles automatic startup enablement
- `Esc` / `Ctrl+[`
- `Ctrl+V` / `Ctrl+Q` for visual block
- On macOS, `Cmd+V` also enters visual block while MVI mode is active

## Notes

- `:set spell`, `:set nospell`, and `z=` use external `aspell`
- Current `aspell` path in the extension is `/opt/homebrew/bin/aspell`
- This extension is currently tailored to the local workspace rather than marketplace publishing
# vscode-mvi
