# MVI

`MVI` is a Codex-generated Vim-like plugin for VS Code. It adds modal editing, Vim-inspired motions and operators, visual selections, search, registers, marks, macros, and a practical subset of ex commands without leaving the built-in VS Code editor.

## What It Is

- Vim-style modal editing inside VS Code
- Generated and iterated in Codex as a local plugin project
- Focused on everyday editing, navigation, and command workflows rather than full Vim compatibility

## Modes

- `normal`
- `insert`
- `replace`
- `visual`
- `visual-line`
- `visual-block`

The extension also renders modal state with a status bar indicator and uses VS Code decorations for block cursor, visual selections, search preview, and spell highlighting.

## Major Movement Keys

These are the main motions currently implemented in normal mode, and most of them also work in visual modes:

- `h` `j` `k` `l` for left, down, up, right
- `w` `b` `e` for word motions
- `W` `B` `E` for WORD motions
- `0` `^` `$` for line start, first non-blank, line end
- `+` `-` `_` for linewise movement variants
- `|` to jump to a column
- `gg` and `G` to jump to top or a target line
- `ge` for backward word-end motion
- `H` `M` `L` for high, middle, low on screen
- `%` for matching-pair jump
- `f` `F` `t` `T`, plus `;` and `,` to repeat character finds
- `(` `)` for sentence movement
- `{` `}` for paragraph movement
- `[[` and `]]` for section movement
- `/pattern` and `?pattern` for forward/backward search
- `n` and `N` to repeat the last search
- `*` and `Ctrl+A` for word-under-cursor search helpers
- `Ctrl+F` `Ctrl+B` for page moves
- `Ctrl+D` `Ctrl+U` for half-page scroll
- `Ctrl+E` `Ctrl+Y` for line scroll

## Editing And Operators

- Insert and append: `i` `a` `I` `A` `o` `O`
- Replace and substitute: `r` `R` `s`
- Delete and change: `x` `X` `d{motion}` `dd` `D` `c{motion}` `cc` `C` `S`
- Yank and paste: `y{motion}` `yy` `Y` `p` `P`
- Indent and outdent: `>` `<`, including linewise and motion-based forms
- Join lines: `J`
- Repeat last edit: `.`
- Repeat last substitute: `&`
- Undo and tracked line restore: `u` `U`
- Toggle case: `~`
- Uppercase by motion: `gU{motion}` (for example, `gUw`)
- Lowercase by motion: `gu{motion}` (for example, `guw`)
- Increment number under cursor: `#`
- Counts are supported for normal motions and many operators

## Visual Modes

- `v` enters visual mode
- `V` enters visual-line mode
- `Ctrl+V` or `Ctrl+Q` enters visual-block mode
- On macOS, `Cmd+V` also enters visual block while MVI is active
- Visual selections support movement, yank, delete, change, and case toggle
- Visual block supports block insert/append with `I` and `A`

## Registers, Marks, And Macros

- Register selection with `"`
- Named marks with `m{char}`
- Jump to marks with `'{char}` and `` `{char} ``
- Macro recording with `q{register}` ... `q`
- Macro playback with `@{register}` and `@@`

## Search, Tags, And Window Helpers

- Incremental search preview while typing `/` or `?`
- `Ctrl+]` for definition/tag jump
- `Ctrl+T` for tag pop
- `Ctrl+W` to focus the next editor group
- `Ctrl+6` for alternate-file style switching
- `Ctrl+L` and `Ctrl+R` for screen refresh
- `Ctrl+G` for file info
- `Ctrl+Z` toggles Zen Mode
- `ZZ` saves and closes the current editor

## Text Objects

Operator-pending text objects are implemented for:

- `iw` and `aw`
- `is` and `as`
- `ip` and `ap`
- `i"` `a"`, `i'` `a'`, ``i` `` and ``a` ``
- `i(` `a(`, `i)` `a)`, `ib` `ab`
- `i[` `a[`, `i]` `a]`
- `i{` `a{`, `i}` `a}`, `iB` `aB`
- `i<` `a<`, `i>` `a>`

## Ex Commands

MVI includes a useful subset of ex commands, including:

- `:write`, `:quit`, `:wq`, `:x`
- `:edit`
- `:read` and `:read !cmd`
- `:delete`, `:yank`, `:join`
- `:substitute` and `:&`
- `:put`, `:copy`, `:move`
- `:print`, `:list`, `:number`
- `:global` and `:v`
- `:mark`
- `:source`
- `:shell`
- `:args`, `:next`, `:previous`, `:rewind`
- `:tag`, `:tagpop`
- `:preserve`, `:recover`
- `:set`

Line ranges and `%` ranges are also supported for ex commands.

## Explorer Navigation

When MVI is enabled and you are not in insert mode, the VS Code Files explorer also gets Vim-like navigation:

- `h` collapse
- `j` move down
- `k` move up
- `l` expand or open

## Spell Support

- `:set spell` enables spell highlighting
- `:set nospell` disables it
- `:set spell?` shows current spell state
- `z=` shows spelling suggestions for the word under cursor
- Spell support uses external `aspell`
- Current configured path is `/opt/homebrew/bin/aspell`

## Commands And Configuration

- `MVI: Enable`
- `MVI: Disable`
- `mvijs.autoEnable` controls startup auto-enable behavior

## Running Locally

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host window, open a file.
4. MVI enables automatically by default.
5. To opt out, set `mvijs.autoEnable` to `false`.

## Packaging A VSIX

1. Install `vsce`.

```bash
npm install -g @vscode/vsce
```

2. Build the extension package.

```bash
vsce package
```

3. In VS Code, run `Extensions: Install from VSIX...` and choose the generated file.

## Notes

- This project is a Vim-like VS Code extension, not a full Vim compatibility layer.
- The current implementation is tailored to this repository and local workflow first.
