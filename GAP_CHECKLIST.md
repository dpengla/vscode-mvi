# MVI Gap Checklist

This checklist compares the current extension against [`vi(1)` from nvi](/Users/depeng/Projects/nvijs/nvi/man/vi.1). It focuses on user-visible editing behavior, not internal implementation details.

## P0: Core `vi` parity gaps

- [x] Add scroll commands: `Ctrl-D`, `Ctrl-U`, `Ctrl-E`, `Ctrl-Y`.
- [x] Add screen refresh and status commands: `Ctrl-L`, `Ctrl-R`, `Ctrl-G`.
- [x] Add file and line motions: `G`, `_`, `+`, `-`, `space`, `|`.
- [x] Add section motions: `[[` and `]]`.
- [x] Add backtick mark jumps distinct from quote mark jumps: `` `a `` vs `'a`.
- [x] Add repeat-substitute command `&`.
- [x] Add replace mode `R`.
- [x] Add backward delete `X`.
- [x] Add line restore `U`.
- [x] Add write-and-quit `ZZ`.

## P0 implementation order

1. Add the missing motion primitives first.
   Files and methods: [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1286), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L2642), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L793), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1026)
   Scope: `G`, `_`, `+`, `-`, `space`, `|`, `[[`, `]]`, and backtick-mark motion support.
   Reason: these unlock both standalone navigation and operator coverage with the least design ambiguity.

2. Add viewport and scroll commands next.
   Files and methods: [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L793), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1026), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L430), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L3047)
   Scope: `Ctrl-D`, `Ctrl-U`, `Ctrl-E`, `Ctrl-Y`, `Ctrl-L`, `Ctrl-R`, `Ctrl-G`.
   Reason: these are user-visible parity gaps but mostly isolated from text mutation logic.

3. Implement edit commands with minimal state impact.
   Files and methods: [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L793), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L2124), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1471)
   Scope: `X`, `R`, `&`.
   Reason: `X` is simple, `R` needs insert/replace session rules, and `&` depends on tracking last substitute state.

4. Implement commands that need new persistent state.
   Files and methods: [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L8), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1562), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L2124)
   Scope: `U`, `ZZ`.
   Reason: `U` needs per-line undo snapshot behavior distinct from `u`, and `ZZ` should respect dirty-state/write semantics.

5. Reconcile the mark and mode conflicts before closing P0.
   Files and methods: [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L2115), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L793), [`extension.js`](/Users/depeng/Projects/vscode-mvi/extension.js#L1026)
   Scope: proper `'a` vs `` `a `` behavior and validation that no new binding conflicts were introduced.
   Reason: this is the main semantic gap inside otherwise-existing functionality.

## P0 implementation notes

- Motion work should extend both `move()` and `computeMotionTarget()` so operators inherit the new motions automatically.
- Scroll commands should prefer VS Code commands where possible, but must preserve MVI selection/mode expectations after the command returns.
- `Ctrl-G` should use VS Code messaging or status surfaces to show file name, modified state, readonly state, current line, total lines, and percentage through file.
- `Ctrl-L` and `Ctrl-R` can likely be treated as refresh/reveal operations rather than true terminal repaints.
- `R` should define whether MVI models classic replace mode as a dedicated mode or as insert mode with overwrite semantics.
- `&` needs storage for the last substitute pattern, replacement, and flags; current substitute handling does not retain that state.
- `U` should be specified carefully before implementation because classic vi restores the current line to the state before the cursor last left it, which is not the same as one-step undo.
- `ZZ` should probably save then close the active editor, but only after confirming the desired multi-file semantics for this extension.
- `[[` and `]]` need a practical definition in VS Code buffers; start with section-header heuristics or paragraph-style fallbacks if exact nvi section parsing is out of scope.

## P1: Common navigation and editing commands still missing

- [x] Add `Ctrl-A` word search under cursor.
- [x] Add tag navigation: `Ctrl-]` and `Ctrl-T`.
- [x] Add alternate file switch: `Ctrl-^`.
- [x] Add window/screen management parity where feasible: `Ctrl-W`, `Ctrl-Z`.
- [x] Add line yank alias `Y`.
- [x] Add number increment/decrement commands: `#`, `#+`, `#-`.
- [x] Add operator shifts: `<motion` and `>motion`.
- [x] Add motion target `|` support for operators.
- [x] Add section motions `[[` / `]]` as operator targets too.

## P2: Ex command surface still missing

- [x] Add `:read {file}` in addition to existing `:r !`.
- [x] Add `:edit[!] [file]`.
- [x] Add `:file`.
- [x] Add `:next`, `:previous`, `:rewind`, `:args`.
- [x] Add `:put [buffer]`.
- [x] Add `:move`, `:copy`, `:t`.
- [x] Add `:<` and `:>` line shifting.
- [x] Add `:=`.
- [x] Add `:print`, `:list`, `:number` / `:#`.
- [x] Add `:global` and `:v`.
- [x] Add `:mark` / `:k`.
- [x] Add `:source`.
- [x] Add `:shell`.
- [x] Add `:help`.
- [x] Add `:version`.
- [x] Add tag-family ex commands: `:tag`, `:tagnext`, `:tagprev`, `:tagpop`, `:tagtop`.
- [x] Add recovery/session commands where meaningful: `:recover`, `:preserve`.

## P3: `:set` option coverage

- [x] Expand `:set` beyond `spell`, `nospell`, and `spell?`.
- [x] Decide which `vi(1)` options should map to VS Code behavior vs remain unsupported.
- [x] Implement high-value options first:
- [x] `number`
- [x] `ignorecase`
- [x] `wrapscan`
- [x] `showmode`
- [x] `shiftwidth`
- [x] `tabstop`
- [x] `expandtab`
- [x] `autoindent`
- [x] `readonly`
- [x] `ruler`
- [x] `list`

## P4: Search and address semantics

- [x] Upgrade `/` and `?` to real `vi` regular-expression behavior instead of current literal-string matching.
- [x] Support empty search pattern reuse exactly as `vi`.
- [x] Support search offsets and trailing `z` forms from the manpage.
- [x] Expand ex address parsing beyond `%`, `.`, `$`, numeric lines, and visual range marks.
- [x] Support marks and search addresses in ex ranges.

## P5: Behavioral mismatches to resolve

- [x] Reconcile `Q`: `vi(1)` uses it for ex mode, but MVI currently uses `Q` for visual block.
- [x] Confirm whether visual block should move to another key to free `Q`.
- [x] Audit current command semantics against `vi(1)` for edge cases:
- [x] counts on insert-family commands
- [x] repeat `.` coverage
- [x] join spacing behavior
- [x] linewise vs characterwise register semantics
- [x] search wrap and repeat behavior

## Already implemented or partially implemented

- [x] Basic motions: `h`, `j`, `k`, `l`, `w`, `b`, `e`, `W`, `B`, `E`, `0`, `^`, `$`, `%`, `H`, `M`, `L`
- [x] Sentence and paragraph motions: `(`, `)`, `{`, `}`
- [x] Find motions: `f`, `F`, `t`, `T`, `;`, `,`
- [x] Core edits: `i`, `a`, `I`, `A`, `o`, `O`, `x`, `D`, `C`, `S`, `J`, `u`, `~`
- [x] Operators and registers: `d`, `c`, `y`, `"`, `p`, `P`
- [x] Search repeat: `/`, `?`, `n`, `N`
- [x] Visual modes: character, line, block
- [x] Macros: `q`, `@`
- [x] Marks: `m` and basic quote-jump behavior
- [x] Ex commands: `:w`, `:q`, `:q!`, `:wq`, `:x`, `:d`, `:y`, `:j`, `:s`, `:!`, `:r !`, `:undo`, `:redo`

## Notes

- Search and ex addressing are now broader, but still optimized for practical VS Code parity over exact `nvi` behavior.
- This checklist should be updated as features land so it remains the parity source of truth.
- Several items are implemented as pragmatic VS Code approximations rather than exact `nvi` behavior:
- `Ctrl-W`, `Ctrl-Z`, tag navigation, `:recover`, `:preserve`, and argument-list commands
- `Q` now enters ex command entry; visual block remains available through the dedicated keybindings
- `#`, `#+`, and `#-` are covered through number-adjust support, but exact historic keystroke timing semantics are not modeled
