const vscode = require("vscode");
const { spawn } = require("child_process");

const MODE_CONTEXT_KEY = "mvijs.mode";
const ENABLED_CONTEXT_KEY = "mvijs.enabled";
const EX_CONTEXT_KEY = "mvijs.exMode";

class MviController {
  constructor(context) {
    this.context = context;
    this.enabled = false;
    this.mode = "normal";
    this.pendingOperator = null;
    this.visualAnchor = null;
    this.lastSearch = null;
    this.marks = new Map();
    this.lastEdit = null;
    this.insertSession = null;
    this.lastInsertedText = "";
    this.lastFind = null;
    this.recordingMacroRegister = null;
    this.lastMacroRegister = null;
    this.isPlayingMacro = false;
    this.pendingCount = "";
    this.pendingPrefixCount = 1;
    this.savedCursorOptions = new WeakMap();
    this.visualBlockActive = null;
    this.visualBlockColumn = null;
    this.exCommandLine = null;
    this.spellEnabled = false;
    this.spellProgram = "/opt/homebrew/bin/aspell";
    this.spellRefreshTimer = null;
    this.spellRequestId = 0;
    this.scrollLineCount = null;
    this.lastSubstitute = null;
    this.trackedLineState = null;
    this.alternateDocumentUri = null;
    this.currentDocumentUri = null;
    this.tagStack = [];
    this.options = {
      number: false,
      ignorecase: false,
      wrapscan: true,
      showmode: true,
      shiftwidth: 2,
      tabstop: 2,
      expandtab: true,
      autoindent: true,
      readonly: false,
      ruler: false,
      list: false
    };
    this.registers = new Map([["\"", { text: "", linewise: false }]]);
    this.selectedRegister = "\"";
    this.pendingRegister = false;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -900);
    this.statusBar.name = "MVI Mode";
    this.statusBar.command = "mvijs.disable";
    this.exStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1001);
    this.exStatusBar.name = "MVI Ex Command";
    this.outputChannel = vscode.window.createOutputChannel("MVI");
    this.normalCursorDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editorCursor.foreground"),
      color: new vscode.ThemeColor("editor.background")
    });
    this.normalEmptyCursorDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: "\u00a0",
        backgroundColor: new vscode.ThemeColor("editorCursor.foreground"),
        color: new vscode.ThemeColor("editor.background"),
        width: "0.9ch"
      }
    });
    this.visualLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editor.selectionHighlightBorder")
    });
    this.visualLineEmptyDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: "\u00a0",
        backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
        width: "1ch",
        borderRadius: "2px"
      }
    });
    this.visualBlockDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editor.selectionHighlightBorder")
    });
    this.visualBlockEmptyDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: "\u00a0",
        backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
        width: "1ch",
        borderRadius: "2px"
      }
    });
    this.cursorLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.lineHighlightBackground")
    });
    this.spellErrorDecoration = vscode.window.createTextEditorDecorationType({
      textDecoration: "underline wavy var(--vscode-editorError-foreground)",
      overviewRulerColor: new vscode.ThemeColor("editorError.foreground")
    });
    this.searchPreviewDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      borderColor: new vscode.ThemeColor("editor.findMatchHighlightBorder"),
      borderWidth: "1px",
      borderStyle: "solid"
    });
    this.matchingBracketDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
      borderWidth: "2px",
      borderStyle: "solid"
    });
  }

  async setContext(key, value) {
    await vscode.commands.executeCommand("setContext", key, value);
  }

  async enable() {
    this.enabled = true;
    this.pendingOperator = null;
    this.clearPendingCounts();
    await this.setContext(ENABLED_CONTEXT_KEY, true);
    await this.setContext(EX_CONTEXT_KEY, false);
    await this.setMode("normal");
    this.statusBar.show();
    this.exStatusBar.show();
    this.captureCurrentLineState(vscode.window.activeTextEditor);
    this.refresh();
  }

  async disable() {
    this.enabled = false;
    this.pendingOperator = null;
    this.pendingRegister = false;
    this.visualAnchor = null;
    this.visualBlockActive = null;
    this.visualBlockColumn = null;
    this.exCommandLine = null;
    this.lastFind = null;
    this.clearPendingCounts();
    this.clearSelectedRegister();
    await this.setContext(ENABLED_CONTEXT_KEY, false);
    await this.setContext(EX_CONTEXT_KEY, false);
    this.mode = "normal";
    await this.setContext(MODE_CONTEXT_KEY, "normal");
    this.clearDecorations();
    this.clearSpellDecorations();
    for (const editor of vscode.window.visibleTextEditors) {
      this.restoreCursorStyle(editor);
    }
    this.statusBar.hide();
    this.exStatusBar.hide();
  }

  async setMode(mode) {
    const previousMode = this.mode;
    if (previousMode === "insert" && mode !== "insert") {
      this.finalizeInsertSession();
    }
    this.mode = mode;
    if (mode === "insert" && previousMode !== "insert") {
      this.beginInsertSession();
    }
    if (!String(mode).startsWith("visual")) {
      this.visualAnchor = null;
    }
    if (mode !== "visual-block") {
      this.visualBlockActive = null;
      this.visualBlockColumn = null;
    }
    if (mode !== "normal") {
      this.clearPendingCounts();
    }
    await this.setContext(MODE_CONTEXT_KEY, mode);
    this.updateStatusBar();
    this.refresh();
  }

  updateStatusBar() {
    if (this.exCommandLine) {
      this.exStatusBar.text = `${this.exCommandLine.prefix || ":"}${this.exCommandLine.value}`;
      return;
    }
    this.exStatusBar.text = " ";
    this.statusBar.text = this.formatStatusBarText();
  }

  formatStatusBarText(extra = "", label = this.mode) {
    const base = `-- ${String(label).toUpperCase()} --`;
    const suffix = extra ? ` ${extra}` : "";
    const spellSuffix = this.spellEnabled ? " SPELL" : "";
    const rulerSuffix = this.options.ruler ? ` ${this.rulerText()}` : "";
    return `${base}${suffix}${spellSuffix}${rulerSuffix}`;
  }

  rulerText(editor = this.getEditor()) {
    if (!editor) {
      return "";
    }
    const document = editor.document;
    const active = editor.selection.active;
    return `${active.line + 1},${active.character + 1}`;
  }

  isActiveEditor(editor) {
    return Boolean(editor && editor === vscode.window.activeTextEditor);
  }

  getEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled || !editor || editor.document.isClosed) {
      return null;
    }
    return editor;
  }

  clearDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.normalCursorDecoration, []);
      editor.setDecorations(this.normalEmptyCursorDecoration, []);
      editor.setDecorations(this.visualLineDecoration, []);
      editor.setDecorations(this.visualLineEmptyDecoration, []);
      editor.setDecorations(this.visualBlockDecoration, []);
      editor.setDecorations(this.visualBlockEmptyDecoration, []);
      editor.setDecorations(this.searchPreviewDecoration, []);
      editor.setDecorations(this.matchingBracketDecoration, []);
      editor.setDecorations(this.cursorLineDecoration, []);
    }
  }

  clearSpellDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.spellErrorDecoration, []);
    }
  }

  setCursorStyle(editor, style) {
    if (!editor) {
      return;
    }
    if (!this.savedCursorOptions.has(editor)) {
      this.savedCursorOptions.set(editor, {
        cursorStyle: editor.options.cursorStyle,
        cursorBlinking: editor.options.cursorBlinking
      });
    }
    if (editor.options.cursorStyle !== style || editor.options.cursorBlinking !== "solid") {
      editor.options = {
        ...editor.options,
        cursorStyle: style,
        cursorBlinking: "solid"
      };
    }
  }

  restoreCursorStyle(editor) {
    if (!editor || !this.savedCursorOptions.has(editor)) {
      return;
    }
    const saved = this.savedCursorOptions.get(editor);
    if (editor.options.cursorStyle !== saved.cursorStyle || editor.options.cursorBlinking !== saved.cursorBlinking) {
      editor.options = {
        ...editor.options,
        cursorStyle: saved.cursorStyle,
        cursorBlinking: saved.cursorBlinking
      };
    }
  }

  desiredCursorStyle() {
    if (this.mode === "normal" || String(this.mode).startsWith("visual") || this.mode === "replace") {
      return vscode.TextEditorCursorStyle.Block;
    }
    return null;
  }

  refresh(editor = this.getEditor()) {
    this.clearDecorations();
    if (!editor) {
      return;
    }
    for (const visibleEditor of vscode.window.visibleTextEditors) {
      if (visibleEditor !== editor) {
        this.restoreCursorStyle(visibleEditor);
      }
    }
    this.normalizeSelection(editor);
    this.updateStatusBar();
    const active = editor.selection.active;
    if (this.mode === "visual-line" && this.visualAnchor) {
      const { startLine, endLine } = this.visualLineBounds(editor);
      const ranges = [];
      const emptyRanges = [];
      for (let line = startLine; line <= endLine; line += 1) {
        const lineRange = editor.document.lineAt(line).range;
        if (lineRange.isEmpty) {
          emptyRanges.push(new vscode.Range(line, 0, line, 0));
        } else {
          ranges.push(lineRange);
        }
      }
      editor.setDecorations(this.visualLineDecoration, ranges);
      editor.setDecorations(this.visualLineEmptyDecoration, emptyRanges);
    } else if (this.mode === "visual-block") {
      const { ranges, emptyRanges } = this.visualBlockDecorationRanges(editor);
      editor.setDecorations(this.visualBlockDecoration, ranges);
      editor.setDecorations(this.visualBlockEmptyDecoration, emptyRanges);
    }
    const cursorStyle = this.desiredCursorStyle();
    if (cursorStyle) {
      this.setCursorStyle(editor, cursorStyle);
    } else {
      this.restoreCursorStyle(editor);
    }
    if (this.mode === "normal") {
      const range = this.normalCursorRange(editor, active);
      if (range) {
        editor.setDecorations(this.normalCursorDecoration, [range]);
      } else if (editor.document.lineAt(active.line).text.length === 0) {
        editor.setDecorations(this.normalEmptyCursorDecoration, [new vscode.Range(active.line, 0, active.line, 0)]);
      }
    }
    const matchingBracketRange = this.matchingBracketRange(editor.document, active);
    if (matchingBracketRange) {
      editor.setDecorations(this.matchingBracketDecoration, [matchingBracketRange]);
    }
    this.updateSearchPreview(editor);
    if (this.spellEnabled) {
      this.scheduleSpellRefresh(editor);
    } else {
      this.clearSpellDecorations();
    }
    editor.revealRange(new vscode.Range(active, active), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  scheduleSpellRefresh(editor) {
    if (this.spellRefreshTimer) {
      clearTimeout(this.spellRefreshTimer);
    }
    const requestId = ++this.spellRequestId;
    this.spellRefreshTimer = setTimeout(() => {
      this.spellRefreshTimer = null;
      this.refreshSpellDecorations(editor, requestId);
    }, 120);
  }

  async refreshSpellDecorations(editor, requestId) {
    if (!this.enabled || !this.spellEnabled || !this.isActiveEditor(editor)) {
      return;
    }
    const visibleRanges = editor.visibleRanges || [];
    const words = new Map();
    for (const visibleRange of visibleRanges) {
      for (let line = visibleRange.start.line; line <= Math.min(visibleRange.end.line, editor.document.lineCount - 1); line += 1) {
        const text = editor.document.lineAt(line).text;
        const regex = /[A-Za-z']+/gu;
        let match;
        while ((match = regex.exec(text))) {
          const word = match[0];
          if (!words.has(word)) {
            words.set(word, []);
          }
          words.get(word).push(new vscode.Range(line, match.index, line, match.index + word.length));
        }
      }
    }
    const misspelled = await this.fetchMisspelledWords([...words.keys()]);
    if (requestId !== this.spellRequestId || !this.enabled || !this.spellEnabled || !this.isActiveEditor(editor)) {
      return;
    }
    const ranges = [];
    for (const word of misspelled) {
      const entries = words.get(word);
      if (entries) {
        ranges.push(...entries);
      }
    }
    editor.setDecorations(this.spellErrorDecoration, ranges);
  }

  normalizeSelection(editor) {
    if (!editor) {
      return;
    }
    const document = editor.document;
    const selection = editor.selection;
    if (String(this.mode).startsWith("visual")) {
      if (!this.visualAnchor) {
        this.visualAnchor = selection.anchor;
      }
      if (this.mode === "visual-block" && !this.visualBlockActive) {
        this.visualBlockActive = this.clampPosition(document, selection.active);
        this.visualBlockColumn = selection.active.character;
      }
      if (this.mode === "visual-line") {
        const active = this.normalizeNormalPosition(document, this.clampNavigablePosition(document, selection.active));
        if (!selection.anchor.isEqual(active) || !selection.active.isEqual(active)) {
          editor.selection = new vscode.Selection(active, active);
        }
      }
      return;
    }
    let active = selection.active;
    active = this.clampPosition(document, active);
    if (this.mode === "insert" && editor.selections && editor.selections.length > 1) {
      return;
    }
    if (this.mode === "normal") {
      active = this.normalizeNormalPosition(document, active);
    }
    if (!selection.anchor.isEqual(active) || !selection.active.isEqual(active)) {
      editor.selection = new vscode.Selection(active, active);
    }
  }

  clampPosition(document, position) {
    const line = Math.max(0, Math.min(position.line, document.lineCount - 1));
    const lineLength = document.lineAt(line).text.length;
    const character = Math.max(0, Math.min(position.character, lineLength));
    return new vscode.Position(line, character);
  }

  clampVisualBlockPosition(document, position) {
    const line = Math.max(0, Math.min(position.line, document.lineCount - 1));
    const character = Math.max(0, position.character);
    return new vscode.Position(line, character);
  }

  maxNavigableLine(document) {
    const lastLine = document.lineCount - 1;
    if (lastLine > 0 && document.lineAt(lastLine).text.length === 0) {
      return lastLine - 1;
    }
    return lastLine;
  }

  clampNavigablePosition(document, position) {
    const line = Math.max(0, Math.min(position.line, this.maxNavigableLine(document)));
    const lineLength = document.lineAt(line).text.length;
    const character = Math.max(0, Math.min(position.character, lineLength));
    return new vscode.Position(line, character);
  }

  normalizeNormalPosition(document, position) {
    const line = document.lineAt(position.line).text;
    if (!line.length) {
      return new vscode.Position(position.line, 0);
    }
    return new vscode.Position(position.line, Math.min(position.character, line.length - 1));
  }

  normalPositionFromInsert(document, position) {
    const clamped = this.clampPosition(document, position);
    if (clamped.character > 0) {
      return this.normalizeNormalPosition(document, clamped.translate(0, -1));
    }
    if (clamped.line > 0) {
      const previousLine = clamped.line - 1;
      const previousLength = document.lineAt(previousLine).text.length;
      return this.normalizeNormalPosition(document, new vscode.Position(previousLine, previousLength));
    }
    return this.normalizeNormalPosition(document, clamped);
  }

  normalCursorRange(editor, position) {
    const document = editor.document;
    const line = document.lineAt(position.line).text;
    if (!line.length) {
      return null;
    }
    const character = Math.min(position.character, line.length - 1);
    return new vscode.Range(position.line, character, position.line, character + 1);
  }

  async handleType(text) {
    const editor = this.getEditor();
    if (!editor) {
      return vscode.commands.executeCommand("default:type", { text });
    }
    if (this.exCommandLine) {
      this.exCommandLine.value += String(text || "");
      this.updateStatusBar();
      if (this.exCommandLine.prefix === "/" || this.exCommandLine.prefix === "?") {
        this.refresh(editor);
      }
      return;
    }
    if (this.mode === "insert" || this.mode === "replace") {
      this.recordMacroEvent({ type: "type", text });
      if (this.mode === "replace") {
        for (const char of String(text || "")) {
          const active = editor.selection.active;
          const lineText = editor.document.lineAt(active.line).text;
          if (active.character < lineText.length) {
            await editor.edit((editBuilder) => {
              editBuilder.delete(new vscode.Range(active, active.translate(0, 1)));
            });
          }
          await vscode.commands.executeCommand("default:type", { text: char });
        }
        return;
      }
      return vscode.commands.executeCommand("default:type", { text });
    }
    for (const char of String(text || "")) {
      await this.handleNormalInput(editor, char);
    }
  }

  async handleBackspace() {
    const editor = this.getEditor();
    if (!editor) {
      return vscode.commands.executeCommand("deleteLeft");
    }
    if (this.exCommandLine) {
      this.exCommandLine.value = this.exCommandLine.value.slice(0, -1);
      this.updateStatusBar();
      if (this.exCommandLine.prefix === "/" || this.exCommandLine.prefix === "?") {
        this.refresh(editor);
      }
      return;
    }
    if (this.mode === "insert" || this.mode === "replace") {
      this.recordMacroEvent({ type: "backspace" });
      return vscode.commands.executeCommand("deleteLeft");
    }
    if (String(this.mode).startsWith("visual")) {
      await this.setMode("normal");
    }
  }

  async handleEscape() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    if (this.exCommandLine) {
      await this.closeExCommandLine();
      this.refresh(editor);
      return;
    }
    this.pendingOperator = null;
    this.pendingRegister = false;
    this.clearPendingCounts();
    if (this.mode === "insert" || this.mode === "replace") {
      this.recordMacroEvent({ type: "escape" });
      const active = this.normalPositionFromInsert(editor.document, editor.selection.active);
      editor.selection = new vscode.Selection(active, active);
    }
    await this.setMode("normal");
  }

  async handleEnter() {
    if (!this.exCommandLine) {
      return vscode.commands.executeCommand("default:type", { text: "\n" });
    }
    const editor = this.getEditor();
    const { prefix = ":", value = "" } = this.exCommandLine;
    const command = value.trim();
    await this.closeExCommandLine();
    if (!editor) {
      return;
    }
    if (prefix === "/" || prefix === "?") {
      const spec = this.parseSearchSpec(command, prefix === "/" ? 1 : -1);
      if (!spec) {
        this.refresh(editor);
        return;
      }
      this.lastSearch = spec;
      await this.runSearch(editor, spec.pattern, spec.direction, { regex: true, offset: spec.offset || 0 });
      this.refresh(editor);
      return;
    }
    await this.executeExCommand(editor, command);
    this.refresh(editor);
  }

  async closeExCommandLine() {
    this.exCommandLine = null;
    await this.setContext(EX_CONTEXT_KEY, false);
    this.updateStatusBar();
  }

  updateSearchPreview(editor) {
    if (!editor || !this.exCommandLine || !["/", "?"].includes(this.exCommandLine.prefix)) {
      return;
    }
    const spec = this.parseSearchSpec(this.exCommandLine.value, this.exCommandLine.prefix === "/" ? 1 : -1);
    if (!spec || !spec.pattern) {
      return;
    }
    const text = editor.document.getText();
    let regex;
    try {
      regex = new RegExp(spec.pattern, this.searchFlags());
    } catch (_error) {
      return;
    }
    const ranges = [];
    let match;
    while ((match = regex.exec(text))) {
      const start = editor.document.positionAt(match.index);
      const end = editor.document.positionAt(match.index + match[0].length);
      ranges.push(new vscode.Range(start, end));
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
    editor.setDecorations(this.searchPreviewDecoration, ranges);
    const searchStart = this.exCommandLine.startPosition || editor.selection.active;
    const previewStart = this.findSearchPosition(editor.document, searchStart, spec.pattern, spec.direction);
    if (!previewStart) {
      return;
    }
    let position = this.normalizeNormalPosition(editor.document, previewStart);
    if (spec.offset) {
      const line = Math.max(0, Math.min(editor.document.lineCount - 1, position.line + spec.offset));
      position = this.normalizeNormalPosition(editor.document, new vscode.Position(line, 0));
    }
    editor.selection = new vscode.Selection(position, position);
  }

  async handleVisualBlockCommand() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    if (this.mode === "visual-block") {
      const exitPosition = this.visualAnchor || editor.selection.start;
      await this.setMode("normal");
      this.collapseToSelectionStart(editor, exitPosition);
      return;
    }
    await this.enterVisualBlock(editor);
    this.refresh(editor);
  }

  async handlePageMove(forward) {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    const isVisual = String(this.mode).startsWith("visual");
    const command = forward
      ? (isVisual ? "cursorPageDownSelect" : "cursorPageDown")
      : (isVisual ? "cursorPageUpSelect" : "cursorPageUp");
    await vscode.commands.executeCommand(command);
    this.refresh(editor);
  }

  visibleLineSpan(editor) {
    const range = editor.visibleRanges && editor.visibleRanges[0];
    if (!range) {
      return Math.max(1, Math.min(20, editor.document.lineCount));
    }
    return Math.max(1, range.end.line - range.start.line + 1);
  }

  resolveScrollLineCount(editor, explicitCount) {
    if (explicitCount != null) {
      this.scrollLineCount = Math.max(1, explicitCount);
      return this.scrollLineCount;
    }
    if (this.scrollLineCount != null) {
      return this.scrollLineCount;
    }
    this.scrollLineCount = Math.max(1, Math.floor(this.visibleLineSpan(editor) / 2));
    return this.scrollLineCount;
  }

  async handleHalfPageScroll(forward) {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    const count = this.resolveScrollLineCount(editor, this.consumeOptionalCount());
    this.move(editor, forward ? "j" : "k", String(this.mode).startsWith("visual"), count);
    if (this.mode === "visual-line") {
      this.expandVisualLineSelection(editor);
    } else if (this.mode === "visual-block") {
      this.expandVisualBlockSelections(editor);
    }
    this.refresh(editor);
  }

  async handleLineScroll(forward) {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    const count = Math.max(1, this.consumeOptionalCount() || 1);
    await vscode.commands.executeCommand("editorScroll", {
      to: forward ? "down" : "up",
      by: "line",
      value: count,
      revealCursor: false
    });
    this.refresh(editor);
  }

  async handleScreenRefresh() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    await vscode.commands.executeCommand("editor.action.wordWrapColumn");
    await vscode.commands.executeCommand("editor.action.wordWrapColumn");
    this.refresh(editor);
  }

  async handleFileInfo() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    const document = editor.document;
    const line = editor.selection.active.line + 1;
    const total = Math.max(1, document.lineCount);
    const percent = Math.floor((line / total) * 100);
    const flags = [
      document.isDirty ? "modified" : null,
      document.isReadonly || this.options.readonly ? "readonly" : null
    ].filter(Boolean).join(", ");
    const detail = `${document.uri.fsPath || document.fileName} ${flags ? `[${flags}] ` : ""}${line}/${total} ${percent}%`;
    vscode.window.setStatusBarMessage(detail, 3000);
  }

  async handleSearchWordForward() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    const wordRange = this.currentWordRange(editor.document, this.currentPosition(editor));
    if (!wordRange) {
      return;
    }
    const pattern = editor.document.getText(wordRange);
    this.lastSearch = { pattern: `\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, direction: 1, raw: pattern };
    await this.runSearch(editor, this.lastSearch.pattern, 1, { regex: true });
  }

  async handleTagJump() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    this.tagStack.push({
      uri: editor.document.uri.toString(),
      position: editor.selection.active
    });
    await vscode.commands.executeCommand("editor.action.revealDefinition");
  }

  async handleTagPop() {
    const entry = this.tagStack.pop();
    if (!entry) {
      await vscode.commands.executeCommand("workbench.action.navigateBack");
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(entry.position, entry.position);
    this.refresh(editor);
  }

  async handleAlternateFile() {
    if (!this.alternateDocumentUri) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.alternateDocumentUri));
    const editor = await vscode.window.showTextDocument(document);
    this.refresh(editor);
  }

  async handleWindowCommand() {
    await vscode.commands.executeCommand("workbench.action.focusNextGroup");
  }

  async handleSuspendCommand() {
    await vscode.commands.executeCommand("workbench.action.toggleZenMode");
  }

  captureCurrentLineState(editor) {
    if (!editor) {
      this.trackedLineState = null;
      return;
    }
    const line = editor.selection.active.line;
    this.trackedLineState = {
      uri: editor.document.uri.toString(),
      line,
      text: editor.document.lineAt(line).text
    };
  }

  maybeUpdateTrackedLineState(editor) {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri.toString();
    const line = editor.selection.active.line;
    if (!this.trackedLineState || this.trackedLineState.uri !== uri || this.trackedLineState.line !== line) {
      this.captureCurrentLineState(editor);
    }
  }

  async restoreTrackedLine(editor) {
    if (!editor || !this.trackedLineState) {
      return;
    }
    const uri = editor.document.uri.toString();
    const line = editor.selection.active.line;
    if (this.trackedLineState.uri !== uri || this.trackedLineState.line !== line) {
      return;
    }
    const target = editor.document.lineAt(line).range;
    await editor.edit((editBuilder) => {
      editBuilder.replace(target, this.trackedLineState.text);
    });
    this.refresh(editor);
  }

  trackActiveEditor(editor) {
    if (!editor) {
      return;
    }
    const uri = editor.document.uri.toString();
    if (this.currentDocumentUri && this.currentDocumentUri !== uri) {
      this.alternateDocumentUri = this.currentDocumentUri;
    }
    this.currentDocumentUri = uri;
    this.captureCurrentLineState(editor);
  }

  rememberEdit(edit) {
    this.lastEdit = edit || null;
  }

  async setSpellEnabled(editor, enabled) {
    this.spellEnabled = !!enabled;
    if (!this.spellEnabled) {
      this.clearSpellDecorations();
    }
    this.updateStatusBar();
    this.refresh(editor);
  }

  async showSpellingSuggestions(editor) {
    const wordRange = this.currentWordRange(editor.document, this.currentPosition(editor));
    if (!wordRange) {
      vscode.window.setStatusBarMessage("mvi spell: no word under cursor", 2000);
      this.refresh(editor);
      return;
    }
    const word = editor.document.getText(wordRange);
    const suggestions = await this.fetchSpellSuggestions(word);
    if (!suggestions.length) {
      vscode.window.setStatusBarMessage(`mvi spell: no suggestions for ${word}`, 2000);
      this.refresh(editor);
      return;
    }
    const choice = await vscode.window.showQuickPick(suggestions, {
      placeHolder: `z= ${word}`
    });
    if (!choice) {
      this.refresh(editor);
      return;
    }
    await editor.edit((editBuilder) => {
      editBuilder.replace(wordRange, choice);
    });
    const next = this.normalizeNormalPosition(editor.document, wordRange.start);
    editor.selection = new vscode.Selection(next, next);
    this.refresh(editor);
  }

  async fetchSpellSuggestions(word) {
    return new Promise((resolve) => {
      const child = spawn(this.spellProgram, ["-a"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", () => {
        resolve([]);
      });
      child.on("close", () => {
        if (stderr.trim()) {
          resolve([]);
          return;
        }
        resolve(this.parseAspellSuggestions(stdout));
      });
      child.stdin.write(`${word}\n`);
      child.stdin.end();
    });
  }

  async fetchMisspelledWords(words) {
    if (!words.length) {
      return new Set();
    }
    return new Promise((resolve) => {
      const child = spawn(this.spellProgram, ["-a"], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => {
        resolve(new Set());
      });
      child.on("close", () => {
        resolve(this.parseAspellMisspellings(stdout));
      });
      child.stdin.write(`${words.join("\n")}\n`);
      child.stdin.end();
    });
  }

  parseAspellSuggestions(output) {
    const lines = output.split(/\r?\n/).slice(1).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("& ")) {
        const parts = line.split(":");
        if (parts.length < 2) {
          return [];
        }
        return parts[1].split(",").map((item) => item.trim()).filter(Boolean);
      }
      if (line.startsWith("# ") || line.startsWith("*")) {
        return [];
      }
    }
    return [];
  }

  parseAspellMisspellings(output) {
    const result = new Set();
    const lines = output.split(/\r?\n/).slice(1).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("& ") || line.startsWith("# ")) {
        const match = line.match(/^[&#] ([^ ]+)/);
        if (match) {
          result.add(match[1]);
        }
      }
    }
    return result;
  }

  currentWordRange(document, position) {
    const lineText = document.lineAt(position.line).text;
    if (!lineText.length) {
      return null;
    }
    const cursor = Math.min(position.character, Math.max(0, lineText.length - 1));
    if (!this.isSpellWordCharacter(lineText[cursor])) {
      return null;
    }
    let start = cursor;
    let end = cursor + 1;
    while (start > 0 && this.isSpellWordCharacter(lineText[start - 1])) {
      start -= 1;
    }
    while (end < lineText.length && this.isSpellWordCharacter(lineText[end])) {
      end += 1;
    }
    return new vscode.Range(position.line, start, position.line, end);
  }

  isSpellWordCharacter(char) {
    return /[A-Za-z']/u.test(char || "");
  }

  isCountDigit(key) {
    return /^[0-9]$/.test(key);
  }

  pushCountDigit(key) {
    this.pendingCount = `${this.pendingCount}${key}`;
    this.statusBar.text = this.formatStatusBarText(this.pendingCount);
  }

  consumeCount() {
    const count = this.pendingCount ? Number(this.pendingCount) : 1;
    this.pendingCount = "";
    return count;
  }

  consumeOptionalCount() {
    if (!this.pendingCount) {
      return null;
    }
    const count = Number(this.pendingCount);
    this.pendingCount = "";
    return count;
  }

  clearPendingCounts() {
    this.pendingCount = "";
    this.pendingPrefixCount = 1;
  }

  beginPendingCommand(operator) {
    this.pendingPrefixCount = this.consumeCount();
    this.pendingOperator = operator;
  }

  resolvePendingCount() {
    const count = Math.max(1, this.pendingPrefixCount || 1) * Math.max(1, this.consumeCount());
    this.pendingPrefixCount = 1;
    return count;
  }

  resolvePendingOptionalCount() {
    const motionCount = this.consumeOptionalCount();
    const prefixCount = Math.max(1, this.pendingPrefixCount || 1);
    this.pendingPrefixCount = 1;
    if (motionCount === null && prefixCount === 1) {
      return null;
    }
    return prefixCount * Math.max(1, motionCount == null ? 1 : motionCount);
  }

  recordMacroEvent(event) {
    if (!this.recordingMacroRegister || this.isPlayingMacro) {
      return;
    }
    const current = this.registers.get(this.recordingMacroRegister) || { events: [] };
    current.events = current.events || [];
    current.events.push(event);
    this.registers.set(this.recordingMacroRegister, current);
  }

  beginInsertSession() {
    const editor = this.getEditor();
    if (!editor) {
      this.insertSession = null;
      return;
    }
    this.insertSession = {
      uri: editor.document.uri.toString(),
      startOffset: editor.document.offsetAt(editor.selection.active),
      endOffset: editor.document.offsetAt(editor.selection.active),
      text: "",
      valid: true
    };
  }

  finalizeInsertSession() {
    if (!this.insertSession || !this.insertSession.valid) {
      this.insertSession = null;
      return;
    }
    this.lastInsertedText = this.insertSession.text;
    if (this.lastEdit && this.lastEdit.type === "insert") {
      this.lastEdit = {
        ...this.lastEdit,
        text: this.insertSession.text
      };
    }
    this.insertSession = null;
  }

  handleDocumentChange(event) {
    if (!this.enabled || this.mode !== "insert" || !this.insertSession) {
      return;
    }
    if (event.document.uri.toString() !== this.insertSession.uri) {
      return;
    }
    for (const change of event.contentChanges) {
      if (!this.insertSession.valid) {
        return;
      }
      this.applyInsertChange(change);
    }
  }

  applyInsertChange(change) {
    const session = this.insertSession;
    const changeStart = change.rangeOffset;
    const changeEnd = change.rangeOffset + change.rangeLength;
    if (changeEnd < session.startOffset) {
      const delta = change.text.length - change.rangeLength;
      session.startOffset += delta;
      session.endOffset += delta;
      return;
    }
    if (changeStart < session.startOffset) {
      session.valid = false;
      return;
    }
    if (changeStart > session.endOffset) {
      return;
    }
    const localStart = Math.max(0, Math.min(session.text.length, changeStart - session.startOffset));
    const localEnd = Math.max(localStart, Math.min(session.text.length, changeEnd - session.startOffset));
    session.text = `${session.text.slice(0, localStart)}${change.text}${session.text.slice(localEnd)}`;
    session.endOffset += change.text.length - change.rangeLength;
  }

  async handleNormalInput(editor, key, options = {}) {
    const { skipRecord = false } = options;
    if (!this.enabled) {
      return vscode.commands.executeCommand("default:type", { text: key });
    }
    if (String(this.mode).startsWith("visual")) {
      await this.handleVisualInput(editor, key);
      return;
    }
    if (this.pendingRegister) {
      if (!skipRecord) {
        this.recordMacroEvent({ type: "key", key });
      }
      this.selectRegister(key);
      this.refresh(editor);
      return;
    }
    if (this.pendingOperator) {
      const pendingType = this.pendingOperator && typeof this.pendingOperator === "object"
        ? this.pendingOperator.type
        : null;
      const allowsMotionCount = pendingType !== "replace-char" && pendingType !== "record-macro" && pendingType !== "play-macro";
      if (allowsMotionCount && this.isCountDigit(key) && (key !== "0" || this.pendingCount)) {
        if (!skipRecord) {
          this.recordMacroEvent({ type: "key", key });
        }
        this.pushCountDigit(key);
        return;
      }
      if (!(this.pendingOperator && typeof this.pendingOperator === "object" && ["record-macro", "play-macro"].includes(this.pendingOperator.type))) {
        if (!skipRecord) {
          this.recordMacroEvent({ type: "key", key });
        }
      }
      await this.resolveOperator(editor, key);
      return;
    }
    if (this.isCountDigit(key) && (key !== "0" || this.pendingCount)) {
      if (!skipRecord) {
        this.recordMacroEvent({ type: "key", key });
      }
      this.pushCountDigit(key);
      return;
    }
    if (!skipRecord && key !== "q") {
      this.recordMacroEvent({ type: "key", key });
    }
    switch (key) {
      case "h":
      case "j":
      case "k":
      case "l":
      case "w":
      case "b":
      case "e":
      case "W":
      case "B":
      case "E":
      case "(":
      case ")":
      case "{":
      case "}":
      case "+":
      case "-":
      case "_":
      case "|":
      case "G":
      case "0":
      case "^":
      case "$":
      case "%":
      case "H":
      case "M":
      case "L":
        this.move(editor, key, false, key === "G" ? this.consumeOptionalCount() : this.consumeCount());
        this.refresh(editor);
        return;
      case " ":
        this.beginPendingCommand({ type: "space-prefix" });
        this.statusBar.text = this.formatStatusBarText(" ");
        return;
      case "g":
        this.beginPendingCommand({ type: "normal-g" });
        this.statusBar.text = this.formatStatusBarText("g");
        return;
      case "i":
        this.rememberEdit({ type: "insert", insert: "before" });
        await this.setMode("insert");
        return;
      case "a":
        this.moveRightForAppend(editor);
        this.rememberEdit({ type: "insert", insert: "after" });
        await this.setMode("insert");
        return;
      case "I":
        this.moveToFirstNonWhitespace(editor);
        this.rememberEdit({ type: "insert", insert: "lineStart" });
        await this.setMode("insert");
        return;
      case "A":
        this.moveToLineEnd(editor);
        this.rememberEdit({ type: "insert", insert: "lineEnd" });
        await this.setMode("insert");
        return;
      case "o":
        await vscode.commands.executeCommand("editor.action.insertLineAfter");
        this.rememberEdit({ type: "insert", insert: "openBelow" });
        await this.setMode("insert");
        return;
      case "O":
        await vscode.commands.executeCommand("editor.action.insertLineBefore");
        this.rememberEdit({ type: "insert", insert: "openAbove" });
        await this.setMode("insert");
        return;
      case "x":
        {
          const count = this.consumeCount();
          this.rememberEdit({ type: "deleteChar", count });
          await this.deleteRight(editor, count);
        }
        this.refresh(editor);
        return;
      case "X":
        {
          const count = this.consumeCount();
          this.rememberEdit({ type: "deleteLeftChar", count });
          await vscode.commands.executeCommand("deleteLeft");
        }
        this.refresh(editor);
        return;
      case "r":
        this.beginPendingCommand({ type: "replace-char" });
        this.statusBar.text = this.formatStatusBarText("r");
        return;
      case "R":
        this.rememberEdit({ type: "replaceMode" });
        await this.setMode("replace");
        return;
      case "s":
        {
          const count = this.consumeCount();
          this.rememberEdit({ type: "substituteChar", count });
          await this.substituteCharacter(editor, count);
        }
        return;
      case "D":
        this.rememberEdit({ type: "deleteToLineEnd" });
        await this.deleteToLineEnd(editor);
        this.refresh(editor);
        return;
      case "C":
        this.rememberEdit({ type: "changeToLineEnd" });
        await this.changeToLineEnd(editor);
        return;
      case "S":
        this.rememberEdit({ type: "changeLine" });
        await this.changeCurrentLine(editor);
        return;
      case "J":
        this.rememberEdit({ type: "joinLines" });
        await vscode.commands.executeCommand("editor.action.joinLines");
        this.refresh(editor);
        return;
      case "&":
        await this.repeatLastSubstitute(editor);
        return;
      case "/":
        await this.startSearch(editor, 1);
        return;
      case "?":
        await this.startSearch(editor, -1);
        return;
      case ":":
        await this.openExCommand(editor);
        return;
      case "z":
        this.beginPendingCommand({ type: "z-prefix" });
        this.statusBar.text = this.formatStatusBarText("z");
        return;
      case "n":
        await this.repeatSearch(editor, 1, this.consumeCount());
        return;
      case "N":
        await this.repeatSearch(editor, -1, this.consumeCount());
        return;
      case "m":
      case "'":
      case "`":
        this.beginPendingCommand(key);
        this.statusBar.text = this.formatStatusBarText(key);
        return;
      case "[":
        this.beginPendingCommand({ type: "section-prefix", direction: "backward" });
        this.statusBar.text = this.formatStatusBarText("[");
        return;
      case "]":
        this.beginPendingCommand({ type: "section-prefix", direction: "forward" });
        this.statusBar.text = this.formatStatusBarText("]");
        return;
      case "f":
      case "F":
      case "t":
      case "T":
        this.beginPendingCommand({ type: "find", motion: key });
        this.statusBar.text = this.formatStatusBarText(key);
        return;
      case ";":
        await this.repeatFind(editor, false, this.consumeCount());
        return;
      case ",":
        await this.repeatFind(editor, true, this.consumeCount());
        return;
      case "\"":
        this.pendingRegister = true;
        this.statusBar.text = this.formatStatusBarText("\"");
        return;
      case ".":
        await this.repeatLastEdit(editor);
        return;
      case "v":
        this.visualAnchor = editor.selection.active;
        await this.setMode("visual");
        this.refresh(editor);
        return;
      case "V":
        this.visualAnchor = new vscode.Position(editor.selection.active.line, 0);
        await this.setMode("visual-line");
        this.expandVisualLineSelection(editor);
        this.refresh(editor);
        return;
      case "Q":
        await this.openExCommand(editor);
        return;
      case "Y":
        await this.copyCurrentLine(editor, this.consumeCount());
        this.refresh(editor);
        return;
      case "q":
        if (this.recordingMacroRegister) {
          this.stopMacroRecording();
          this.refresh(editor);
          return;
        }
        this.beginPendingCommand({ type: "record-macro" });
        this.statusBar.text = this.formatStatusBarText("q");
        return;
      case "@":
        this.beginPendingCommand({ type: "play-macro" });
        this.statusBar.text = this.formatStatusBarText("@");
        return;
      case "d":
      case "c":
      case "y":
      case "<":
      case ">":
        this.beginPendingCommand(key);
        this.statusBar.text = this.formatStatusBarText(key);
        return;
      case "p":
        await this.pasteRegister(editor, false, this.consumeCount());
        this.refresh(editor);
        return;
      case "P":
        await this.pasteRegister(editor, true, this.consumeCount());
        this.refresh(editor);
        return;
      case "u":
        await vscode.commands.executeCommand("undo");
        this.refresh(editor);
        return;
      case "U":
        await this.restoreTrackedLine(editor);
        return;
      case "#":
        await this.adjustNumberUnderCursor(editor, this.consumeCount(), 1);
        return;
      case "\u0001":
        await this.handleSearchWordForward();
        return;
      case "\u000c":
      case "\u0012":
        await this.handleScreenRefresh();
        return;
      case "\u0007":
        await this.handleFileInfo();
        return;
      case "\u001d":
        await this.handleTagJump();
        return;
      case "\u0014":
        await this.handleTagPop();
        return;
      case "\u0017":
        await this.handleWindowCommand();
        return;
      case "\u001a":
        await this.handleSuspendCommand();
        return;
      case "\u001e":
        await this.handleAlternateFile();
        return;
      case "Z":
        this.beginPendingCommand({ type: "shift-z" });
        this.statusBar.text = this.formatStatusBarText("Z");
        return;
      case "~":
        {
          const count = this.consumeCount();
          this.rememberEdit({ type: "toggleCase", count });
          await this.toggleCaseAtCursor(editor, count);
        }
        this.refresh(editor);
        return;
      default:
        return;
    }
  }

  async handleVisualInput(editor, key) {
    if (this.pendingRegister) {
      this.recordMacroEvent({ type: "key", key });
      this.selectRegister(key);
      this.refresh(editor);
      return;
    }
    if (this.pendingOperator && typeof this.pendingOperator === "object" && this.pendingOperator.type === "section-prefix") {
      if (key === (this.pendingOperator.direction === "backward" ? "[" : "]")) {
        this.move(editor, this.pendingOperator.direction === "backward" ? "[[" : "]]", true, this.resolvePendingCount());
      } else {
        this.clearPendingCounts();
      }
      this.pendingOperator = null;
      this.refresh(editor);
      return;
    }
    if (this.isCountDigit(key) && (key !== "0" || this.pendingCount)) {
      this.recordMacroEvent({ type: "key", key });
      this.pushCountDigit(key);
      return;
    }
    if (key !== "q") {
      this.recordMacroEvent({ type: "key", key });
    }
    switch (key) {
      case "h":
      case "j":
      case "k":
      case "l":
      case "w":
      case "b":
      case "e":
      case "W":
      case "B":
      case "E":
      case "(":
      case ")":
      case "{":
      case "}":
      case " ":
      case "+":
      case "-":
      case "_":
      case "|":
      case "G":
        case "0":
      case "^":
      case "$":
      case "%":
      case "H":
      case "M":
      case "L":
        this.move(editor, key, true, key === "G" ? this.consumeOptionalCount() : this.consumeCount());
        if (this.mode === "visual-line") {
          this.expandVisualLineSelection(editor);
        } else if (this.mode === "visual-block") {
          this.expandVisualBlockSelections(editor);
        }
        this.refresh(editor);
        return;
      case "g":
        this.pendingOperator = { type: "visual-g" };
        this.statusBar.text = this.formatStatusBarText("g");
        return;
      case "[":
        this.pendingOperator = { type: "section-prefix", direction: "backward" };
        this.statusBar.text = this.formatStatusBarText("[");
        return;
      case "]":
        this.pendingOperator = { type: "section-prefix", direction: "forward" };
        this.statusBar.text = this.formatStatusBarText("]");
        return;
      case "y":
        {
          const exitPosition = this.visualAnchor || editor.selection.start;
        await this.yankSelection(editor);
        await this.setMode("normal");
        this.collapseToSelectionStart(editor, exitPosition);
        }
        return;
      case "d":
        await this.deleteSelection(editor);
        await this.setMode("normal");
        this.refresh(editor);
        return;
      case "x":
        await this.deleteSelection(editor);
        await this.setMode("normal");
        this.refresh(editor);
        return;
      case "c":
        await this.deleteSelection(editor);
        await this.setMode("insert");
        this.refresh(editor);
        return;
      case "~":
        await this.toggleCaseInSelections(editor);
        await this.setMode("normal");
        this.refresh(editor);
        return;
      case "I":
        if (this.mode === "visual-block") {
          this.prepareVisualBlockInsert(editor, false);
          await this.setMode("insert");
          this.refresh(editor);
        }
        return;
      case "A":
        if (this.mode === "visual-block") {
          this.prepareVisualBlockInsert(editor, true);
          await this.setMode("insert");
          this.refresh(editor);
        }
        return;
      case "v":
        {
          const exitPosition = this.visualAnchor || editor.selection.start;
        await this.setMode("normal");
        this.collapseToSelectionStart(editor, exitPosition);
        }
        return;
      case "V":
        if (this.mode === "visual-line") {
          const exitPosition = this.visualAnchor || editor.selection.start;
          await this.setMode("normal");
          this.collapseToSelectionStart(editor, exitPosition);
        } else {
          this.visualAnchor = new vscode.Position(editor.selection.active.line, 0);
          await this.setMode("visual-line");
          this.expandVisualLineSelection(editor);
          this.refresh(editor);
        }
        return;
      case "Q":
        await this.openExCommand(editor);
        return;
      case ":":
        await this.openExCommand(editor);
        return;
      default:
        return;
    }
  }

  async resolveOperator(editor, key) {
    const operator = this.pendingOperator;
    this.pendingOperator = null;
    if (operator && typeof operator === "object" && operator.type === "record-macro") {
      this.clearPendingCounts();
      this.startMacroRecording(key);
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "play-macro") {
      await this.playMacro(editor, key, this.resolvePendingCount());
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "replace-char") {
      const count = this.resolvePendingCount();
      this.rememberEdit({ type: "replaceChar", char: key, count });
      await this.replaceCharacter(editor, key, count);
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "shift-z") {
      if (key === "Z") {
        await editor.document.save();
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      }
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "space-prefix") {
      if (key === "j" || key === "k") {
        const count = this.resolvePendingCount();
        for (let i = 0; i < count; i += 1) {
          await this.handlePageMove(key === "j");
        }
        this.refresh(editor);
        return;
      }
      this.move(editor, " ", false, this.resolvePendingCount());
      this.refresh(editor);
      await this.handleNormalInput(editor, key, { skipRecord: true });
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "z-prefix") {
      if (key === "=") {
        await this.showSpellingSuggestions(editor);
        return;
      }
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "find") {
      await this.applyFindKey(editor, operator.motion, key);
      this.clearPendingCounts();
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && (operator.type === "normal-g" || operator.type === "visual-g")) {
      if (key === "e") {
        this.move(editor, "ge", operator.type === "visual-g", this.resolvePendingCount());
        if (this.mode === "visual-line") {
          this.expandVisualLineSelection(editor);
        }
        this.clearPendingCounts();
      } else if (key === "g") {
        const count = this.resolvePendingOptionalCount();
        this.move(editor, "G", operator.type === "visual-g", count == null ? 1 : count);
        if (this.mode === "visual-line") {
          this.expandVisualLineSelection(editor);
        }
        this.clearPendingCounts();
      }
      this.refresh(editor);
      return;
    }
    if ((operator === "d" || operator === "c" || operator === "y") && ["f", "F", "t", "T"].includes(key)) {
      this.pendingOperator = { type: "operator-find", operator, motion: key };
      this.statusBar.text = this.formatStatusBarText(`${operator}${key}`);
      return;
    }
    if (operator === "<" || operator === ">") {
      if (key === operator) {
        await this.shiftLines(editor, operator === ">" ? 1 : -1, this.resolvePendingCount());
        this.refresh(editor);
        return;
      }
      if (["h", "j", "k", "l", "w", "b", "e", "W", "B", "E", "(", ")", "{", "}", " ", "+", "-", "_", "|", "0", "^", "$", "%", "H", "M", "L", "G", "f", "F", "t", "T", "[[", "]]"].includes(key)) {
        await this.applyShiftOperator(editor, operator === ">" ? 1 : -1, key, key === "G" ? this.resolvePendingOptionalCount() : this.resolvePendingCount());
        this.refresh(editor);
        return;
      }
    }
    if (operator && typeof operator === "object" && operator.type === "operator-find") {
      await this.applyOperatorToFind(editor, operator.operator, operator.motion, key);
      this.refresh(editor);
      return;
    }
    if ((operator === "d" || operator === "c" || operator === "y") && (key === "i" || key === "a")) {
      this.pendingOperator = { type: "text-object", operator, kind: key };
      this.statusBar.text = this.formatStatusBarText(`${operator}${key}`);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "text-object") {
      await this.applyTextObject(editor, operator.operator, operator.kind, key);
      this.refresh(editor);
      return;
    }
    if (operator === "d" && key === "d") {
      const count = this.resolvePendingCount();
      this.rememberEdit({ type: "deleteLine", count });
      await this.deleteCurrentLine(editor, count);
      this.refresh(editor);
      return;
    }
    if (operator === "c" && key === "c") {
      const count = this.resolvePendingCount();
      this.rememberEdit({ type: "changeLine", count });
      await this.changeCurrentLine(editor, count);
      return;
    }
    if (operator === "y" && key === "y") {
      await this.copyCurrentLine(editor, this.resolvePendingCount());
      this.refresh(editor);
      return;
    }
    if (operator === "m") {
      this.setMark(key, editor.selection.active);
      this.refresh(editor);
      return;
    }
    if (operator === "'") {
      this.jumpToMark(editor, key, false);
      this.refresh(editor);
      return;
    }
    if (operator === "`") {
      this.jumpToMark(editor, key, true);
      this.refresh(editor);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "section-prefix") {
      if (key === (operator.direction === "backward" ? "[" : "]")) {
        this.move(editor, operator.direction === "backward" ? "[[" : "]]", false, this.resolvePendingCount());
      } else {
        this.clearPendingCounts();
      }
      this.refresh(editor);
      return;
    }
    if (operator === "d" || operator === "c" || operator === "y") {
      if (key === "[") {
        this.pendingOperator = { type: "operator-section", operator, motion: "[[" };
        this.statusBar.text = this.formatStatusBarText(`${operator}[`);
        return;
      }
      if (key === "]") {
        this.pendingOperator = { type: "operator-section", operator, motion: "]]" };
        this.statusBar.text = this.formatStatusBarText(`${operator}]`);
        return;
      }
    }
    if (operator && typeof operator === "object" && operator.type === "operator-section") {
      const expectedKey = operator.motion === "[[" ? "[" : "]";
      if (key === expectedKey) {
        const count = this.resolvePendingCount();
        if (operator.operator === "d") {
          this.rememberEdit({ type: "motionDelete", motion: operator.motion, count });
        } else if (operator.operator === "c") {
          this.rememberEdit({ type: "motionChange", motion: operator.motion, count });
        }
        await this.applyOperatorToMotion(editor, operator.operator, operator.motion, count);
      } else {
        this.clearPendingCounts();
      }
      this.refresh(editor);
      return;
    }
    if ((operator === "<" || operator === ">") && (key === "[" || key === "]")) {
      this.pendingOperator = { type: "operator-section-shift", operator, motion: key === "[" ? "[[" : "]]" };
      this.statusBar.text = this.formatStatusBarText(`${operator}${key}`);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "operator-section-shift") {
      const expectedKey = operator.motion === "[[" ? "[" : "]";
      if (key === expectedKey) {
        await this.applyShiftOperator(editor, operator.operator === ">" ? 1 : -1, operator.motion, this.resolvePendingCount());
      } else {
        this.clearPendingCounts();
      }
      this.refresh(editor);
      return;
    }
    if (key === "g") {
      this.pendingOperator = { type: "g-prefix", operator };
      this.statusBar.text = this.formatStatusBarText(`${operator}g`);
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "g-prefix") {
      const realOperator = operator.operator;
      if (key === "e") {
        const count = this.resolvePendingCount();
        if (realOperator === "d") {
          this.rememberEdit({ type: "motionDelete", motion: "ge", count });
        } else if (realOperator === "c") {
          this.rememberEdit({ type: "motionChange", motion: "ge", count });
        }
        await this.applyOperatorToMotion(editor, realOperator, "ge", count);
        this.refresh(editor);
        return;
      }
      this.clearPendingCounts();
      this.refresh(editor);
      return;
    }
    if (["h", "j", "k", "l", "w", "b", "e", "W", "B", "E", "(", ")", "{", "}", " ", "+", "-", "_", "|", "0", "^", "$", "%", "H", "M", "L", "G", "f", "F", "t", "T"].includes(key)) {
      const count = key === "G" ? this.resolvePendingOptionalCount() : this.resolvePendingCount();
      if (operator === "d") {
        this.rememberEdit({ type: "motionDelete", motion: key, count });
      } else if (operator === "c") {
        this.rememberEdit({ type: "motionChange", motion: key, count });
      }
      await this.applyOperatorToMotion(editor, operator, key, count);
      this.refresh(editor);
      return;
    }
    this.clearPendingCounts();
    this.refresh(editor);
  }

  currentPosition(editor) {
    if (this.mode === "visual-block" && this.visualBlockActive) {
      return new vscode.Position(this.visualBlockActive.line, Math.max(0, this.visualBlockColumn ?? this.visualBlockActive.character));
    }
    return this.mode === "normal"
      ? this.normalizeNormalPosition(editor.document, editor.selection.active)
      : this.clampPosition(editor.document, editor.selection.active);
  }

  move(editor, key, selecting = false, count = 1) {
    const document = editor.document;
    let next = this.currentPosition(editor);
    for (let i = 0; i < Math.max(1, count == null ? 1 : count); i += 1) {
      switch (key) {
        case "h":
          next = next.translate(0, -1);
          break;
        case " ":
        case "l":
          next = next.translate(0, 1);
          break;
        case "j":
          next = new vscode.Position(Math.min(next.line + 1, document.lineCount - 1), next.character);
          break;
        case "k":
          next = new vscode.Position(Math.max(next.line - 1, 0), next.character);
          break;
        case "+":
          next = new vscode.Position(
            Math.min(next.line + 1, document.lineCount - 1),
            this.firstNonWhitespace(document.lineAt(Math.min(next.line + 1, document.lineCount - 1)).text)
          );
          break;
        case "-":
          next = new vscode.Position(
            Math.max(next.line - 1, 0),
            this.firstNonWhitespace(document.lineAt(Math.max(next.line - 1, 0)).text)
          );
          break;
        case "_":
          next = new vscode.Position(
            Math.min(next.line + Math.max(0, (count == null ? 1 : count) - 1), document.lineCount - 1),
            this.firstNonWhitespace(document.lineAt(Math.min(next.line + Math.max(0, (count == null ? 1 : count) - 1), document.lineCount - 1)).text)
          );
          i = count == null ? 1 : count;
          break;
        case "0":
          next = new vscode.Position(next.line, 0);
          break;
        case "|":
          next = new vscode.Position(next.line, Math.max(0, (count == null ? 1 : count) - 1));
          i = count == null ? 1 : count;
          break;
        case "^":
          next = new vscode.Position(next.line, this.firstNonWhitespace(document.lineAt(next.line).text));
          break;
        case "$":
          next = new vscode.Position(next.line, document.lineAt(next.line).text.length);
          break;
        case "G":
          {
            const targetLine = count == null
              ? this.maxNavigableLine(document)
              : Math.max(0, Math.min(document.lineCount - 1, count - 1));
            next = new vscode.Position(targetLine, this.firstNonWhitespace(document.lineAt(targetLine).text));
            i = count == null ? 1 : count;
          }
          break;
        case "w":
          next = this.nextWordStart(document, next);
          break;
        case "b":
          next = this.previousWordStart(document, next);
          break;
        case "e":
          next = this.wordEnd(document, next);
          break;
        case "W":
          next = this.nextBigWordStart(document, next);
          break;
        case "B":
          next = this.previousBigWordStart(document, next);
          break;
        case "E":
          next = this.bigWordEnd(document, next);
          break;
        case "(":
          next = this.previousSentenceStart(document, next);
          break;
        case ")":
          next = this.nextSentenceStart(document, next);
          break;
        case "{":
          next = this.previousParagraphStart(document, next);
          break;
        case "}":
          next = this.nextParagraphStart(document, next);
          break;
        case "[[":
          next = this.previousSectionStart(document, next);
          break;
        case "]]":
          next = this.nextSectionStart(document, next);
          break;
        case "ge":
          next = this.previousWordEnd(document, next);
          break;
        case "%":
          next = this.matchPair(document, next);
          break;
        case "H":
          next = this.viewportMotion(editor, "top");
          i = count;
          break;
        case "M":
          next = this.viewportMotion(editor, "middle");
          i = count;
          break;
        case "L":
          next = this.viewportMotion(editor, "bottom");
          i = count;
          break;
        default:
          break;
      }
    }
    next = (this.mode === "normal" || this.mode === "visual-line")
      ? this.normalizeNormalPosition(document, this.clampNavigablePosition(document, next))
      : (this.mode === "visual-block" ? this.clampVisualBlockPosition(document, next) : this.clampPosition(document, next));
    if (selecting && this.visualAnchor) {
      if (this.mode === "visual-block") {
        this.visualBlockActive = next;
        this.visualBlockColumn = next.character;
        const visible = this.clampPosition(document, next);
        editor.selection = new vscode.Selection(visible, visible);
        this.expandVisualBlockSelections(editor);
        return;
      }
      editor.selection = this.mode === "visual-line"
        ? new vscode.Selection(next, next)
        : new vscode.Selection(this.visualAnchor, next);
      return;
    }
    editor.selection = new vscode.Selection(next, next);
  }

  expandVisualLineSelection(editor) {
    if (!this.visualAnchor) {
      return;
    }
    editor.selection = new vscode.Selection(
      editor.selection.active,
      editor.selection.active
    );
  }

  visualLineBounds(editor) {
    const activeLine = Math.min(editor.selection.active.line, this.maxNavigableLine(editor.document));
    return {
      startLine: Math.min(this.visualAnchor.line, activeLine),
      endLine: Math.max(this.visualAnchor.line, activeLine)
    };
  }

  expandVisualBlockSelections(editor) {
    if (!this.visualAnchor) {
      return;
    }
    const active = this.visualBlockActive || editor.selection.active;
    const visible = this.clampPosition(editor.document, active);
    editor.selection = new vscode.Selection(visible, visible);
  }

  async enterVisualBlock(editor) {
    this.visualAnchor = editor.selection.active;
    this.visualBlockActive = editor.selection.active;
    this.visualBlockColumn = editor.selection.active.character;
    await this.setMode("visual-block");
    this.expandVisualBlockSelections(editor);
  }

  prepareVisualBlockInsert(editor, append) {
    const bounds = this.visualBlockBounds(editor);
    if (!bounds) {
      return;
    }
    editor.selections = Array.from({ length: bounds.endLine - bounds.startLine + 1 }, (_, offset) => {
      const line = bounds.startLine + offset;
      const lineLength = editor.document.lineAt(line).text.length;
      const baseCharacter = Math.min(bounds.startCol, lineLength);
      const position = append
        ? new vscode.Position(line, Math.min(baseCharacter + 1, lineLength))
        : new vscode.Position(line, baseCharacter);
      return new vscode.Selection(position, position);
    });
  }

  moveRightForAppend(editor) {
    const document = editor.document;
    const active = this.currentPosition(editor);
    const lineLength = document.lineAt(active.line).text.length;
    const next = new vscode.Position(active.line, Math.min(active.character + 1, lineLength));
    editor.selection = new vscode.Selection(next, next);
  }

  moveToFirstNonWhitespace(editor) {
    const active = this.currentPosition(editor);
    const character = this.firstNonWhitespace(editor.document.lineAt(active.line).text);
    const next = new vscode.Position(active.line, character);
    editor.selection = new vscode.Selection(next, next);
  }

  moveToLineEnd(editor) {
    const active = this.currentPosition(editor);
    const next = new vscode.Position(active.line, editor.document.lineAt(active.line).text.length);
    editor.selection = new vscode.Selection(next, next);
  }

  async deleteRight(editor, count = 1) {
    const active = this.currentPosition(editor);
    const line = editor.document.lineAt(active.line).text;
    if (!line.length || active.character >= line.length) {
      return;
    }
    const range = new vscode.Range(active, new vscode.Position(active.line, Math.min(line.length, active.character + Math.max(1, count))));
    this.captureDeletedText(editor.document.getText(range), false);
    await editor.edit((editBuilder) => {
      editBuilder.delete(range);
    });
    const next = this.normalizeNormalPosition(editor.document, active);
    editor.selection = new vscode.Selection(next, next);
  }

  async substituteCharacter(editor, count = 1) {
    await this.deleteRight(editor, count);
    await this.setMode("insert");
  }

  async replaceCharacter(editor, char, count = 1) {
    if (typeof char !== "string" || char.length !== 1) {
      return;
    }
    const active = this.currentPosition(editor);
    const lineText = editor.document.lineAt(active.line).text;
    if (!lineText.length || active.character >= lineText.length) {
      return;
    }
    const width = Math.min(Math.max(1, count), lineText.length - active.character);
    const replacement = char.repeat(width);
    await editor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(active, active.translate(0, width)), replacement);
    });
    editor.selection = new vscode.Selection(active, active);
  }

  async deleteToLineEnd(editor) {
    const active = this.currentPosition(editor);
    const lineEnd = editor.document.lineAt(active.line).range.end;
    if (active.isEqual(lineEnd)) {
      return;
    }
    this.captureDeletedText(editor.document.getText(new vscode.Range(active, lineEnd)), false);
    await editor.edit((editBuilder) => {
      editBuilder.delete(new vscode.Range(active, lineEnd));
    });
    editor.selection = new vscode.Selection(active, active);
  }

  async changeToLineEnd(editor) {
    await this.deleteToLineEnd(editor);
    await this.setMode("insert");
  }

  async deleteCurrentLine(editor, count = 1) {
    const line = editor.selection.active.line;
    const document = editor.document;
    const endLine = Math.min(document.lineCount - 1, line + Math.max(1, count) - 1);
    const start = new vscode.Position(line, 0);
    let target;
    let next;
    if (endLine < document.lineCount - 1) {
      target = new vscode.Range(start, new vscode.Position(endLine + 1, 0));
      next = this.normalizeNormalPosition(document, new vscode.Position(line, 0));
    } else if (line > 0) {
      const previous = new vscode.Position(line - 1, document.lineAt(line - 1).text.length);
      target = new vscode.Range(previous, document.lineAt(endLine).range.end);
      next = this.normalizeNormalPosition(document, previous);
    } else {
      target = new vscode.Range(start, document.lineAt(endLine).range.end);
      next = new vscode.Position(0, 0);
    }
    this.captureDeletedText(document.getText(target), true);
    await editor.edit((editBuilder) => {
      editBuilder.delete(target);
    });
    editor.selection = new vscode.Selection(next, next);
  }

  async changeCurrentLine(editor, count = 1) {
    await this.deleteCurrentLine(editor, count);
    await this.setMode("insert");
  }

  async startSearch(editor, direction) {
    this.exCommandLine = {
      prefix: direction > 0 ? "/" : "?",
      value: "",
      startPosition: editor.selection.active
    };
    await this.setContext(EX_CONTEXT_KEY, true);
    this.updateStatusBar();
    this.refresh(editor);
  }

  async openExCommand(editor) {
    this.exCommandLine = { prefix: ":", value: this.exVisualRangePrefix(editor) };
    await this.setContext(EX_CONTEXT_KEY, true);
    this.updateStatusBar();
    this.refresh(editor);
  }

  async executeExCommand(editor, command) {
    if (!command) {
      return;
    }
    const parsed = this.parseExCommand(editor, command);
    if (!parsed) {
      return;
    }
    const { range, command: exCommand } = parsed;
    const ex = exCommand.trim();
    const lower = ex.toLowerCase();
    if (!ex) {
      if (range) {
        this.jumpToLine(editor, range.end);
      }
      return;
    }
    if (lower === "u" || lower === "undo") {
      await vscode.commands.executeCommand("undo");
      return;
    }
    if (lower.startsWith("set")) {
      await this.executeSetCommand(ex.slice(3).trim());
      return;
    }
    if (lower === "redo") {
      await vscode.commands.executeCommand("redo");
      return;
    }
    if (/^(e|edit)(!?)(\s+(.+))?$/i.test(ex)) {
      const match = ex.match(/^(e|edit)(!?)(\s+(.+))?$/i);
      const fileArg = match && match[4] ? match[4].trim() : "";
      if (fileArg) {
        await this.openEditorPath(editor, fileArg);
      } else {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
      return;
    }
    if (/^(w|write)(\s+(.+))?$/i.test(ex)) {
      const match = ex.match(/^(w|write)(\s+(.+))?$/i);
      const fileArg = match && match[3] ? match[3].trim() : "";
      if (fileArg) {
        const target = this.resolvePath(editor, fileArg);
        await vscode.workspace.fs.writeFile(target, Buffer.from(editor.document.getText(), "utf8"));
      } else {
        await editor.document.save();
      }
      return;
    }
    if (/^!/.test(ex)) {
      await this.executeFilterShellCommand(editor, range || this.currentLineRange(editor), ex.slice(1).trim());
      return;
    }
    if (/^r\s*!/i.test(ex)) {
      await this.executeReadShellCommand(editor, range || this.currentLineRange(editor), ex.replace(/^r\s*!/i, "").trim());
      return;
    }
    if (/^(r|read)\s+.+$/i.test(ex)) {
      await this.executeReadFile(editor, range || this.currentLineRange(editor), ex.replace(/^(r|read)\s+/i, "").trim());
      return;
    }
    if (lower === "q" || lower === "q!") {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      return;
    }
    if (lower === "wq" || lower === "x") {
      await editor.document.save();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      return;
    }
    if (lower === "preserve") {
      await editor.document.save();
      return;
    }
    if (lower.startsWith("recover")) {
      await vscode.commands.executeCommand("workbench.action.files.revert");
      return;
    }
    if (lower === "d" || lower === "delete") {
      await this.executeDeleteRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (lower === "y" || lower === "yank") {
      await this.executeYankRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (lower === "j" || lower === "join") {
      await this.executeJoinRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (/^s./i.test(ex)) {
      await this.executeSubstitute(editor, ex, range);
      return;
    }
    if (lower === "&") {
      await this.repeatLastSubstitute(editor);
      return;
    }
    if (lower === "file" || lower === "f") {
      vscode.window.setStatusBarMessage(editor.document.uri.fsPath || editor.document.fileName, 3000);
      return;
    }
    if (/^(n|next)\b/i.test(ex)) {
      await this.navigateArguments(editor, 1);
      return;
    }
    if (/^(prev|previous)\b/i.test(ex)) {
      await this.navigateArguments(editor, -1);
      return;
    }
    if (/^(rew|rewind)\b/i.test(ex)) {
      await this.rewindArguments(editor);
      return;
    }
    if (/^(args|ar)\b/i.test(ex)) {
      this.showOutput("Arguments", this.argumentList(editor).map((uri) => uri.fsPath));
      return;
    }
    if (/^(pu|put)\b/i.test(ex)) {
      const match = ex.match(/^(pu|put)(\s+(.+))?$/i);
      await this.executePut(editor, (range || this.currentLineRange(editor)).end, match && match[3] ? match[3].trim() : null);
      return;
    }
    if (/^(co|copy|t)\b/i.test(ex)) {
      const match = ex.match(/^(co|copy|t)\s+(.+)$/i);
      if (match) {
        const destination = this.parseExAddress(editor, match[2].trim());
        if (destination != null) {
          await this.executeCopyRange(editor, range || this.currentLineRange(editor), destination);
        }
      }
      return;
    }
    if (/^(m|move)\b/i.test(ex)) {
      const match = ex.match(/^(m|move)\s+(.+)$/i);
      if (match) {
        const destination = this.parseExAddress(editor, match[2].trim());
        if (destination != null) {
          await this.executeMoveRange(editor, range || this.currentLineRange(editor), destination);
        }
      }
      return;
    }
    if (/^>{1,}$/.test(ex) || /^<{1,}$/.test(ex)) {
      await this.shiftLineRange(editor, (range || this.currentLineRange(editor)).start, (range || this.currentLineRange(editor)).end, ex.startsWith(">") ? 1 : -1);
      return;
    }
    if (ex === "=") {
      vscode.window.setStatusBarMessage(String((range || this.currentLineRange(editor)).end + 1), 2000);
      return;
    }
    if (/^(p|print)\b/i.test(ex)) {
      this.showExRange(editor, range || this.currentLineRange(editor), "print");
      return;
    }
    if (/^(l|list)\b/i.test(ex)) {
      this.showExRange(editor, range || this.currentLineRange(editor), "list");
      return;
    }
    if (/^(nu|number|#)\b/i.test(ex)) {
      this.showExRange(editor, range || this.currentLineRange(editor), "number");
      return;
    }
    if (/^(g|global|v)\//i.test(ex)) {
      await this.executeGlobal(editor, range || { start: 0, end: editor.document.lineCount - 1 }, ex);
      return;
    }
    if (/^(k|mark)\s+[A-Za-z]$/i.test(ex)) {
      this.setMark(ex.trim().slice(-1), new vscode.Position((range || this.currentLineRange(editor)).start, 0));
      return;
    }
    if (/^so(u|urce)?\b/i.test(ex)) {
      await this.executeSource(editor, ex.replace(/^so(u|urce)?\s*/i, "").trim());
      return;
    }
    if (/^sh(e|el|ell)?\b/i.test(ex)) {
      this.executeShellCommand();
      return;
    }
    if (/^h(e|el|elp)?\b/i.test(ex)) {
      this.showHelp();
      return;
    }
    if (/^ve(r|rs|rsi|rsio|rsion)?\b/i.test(ex)) {
      this.showVersion();
      return;
    }
    if (/^ta(g)?\b/i.test(ex)) {
      await this.handleTagJump();
      return;
    }
    if (/^tagp(op)?\b/i.test(ex)) {
      await this.handleTagPop();
      return;
    }
    if (/^tagn(ext)?\b/i.test(ex)) {
      await vscode.commands.executeCommand("workbench.action.navigateForward");
      return;
    }
    if (/^tagpr(ev)?\b/i.test(ex)) {
      await vscode.commands.executeCommand("workbench.action.navigateBack");
      return;
    }
    if (/^tagt(op)?\b/i.test(ex)) {
      this.tagStack = [];
      return;
    }
  }

  async executeReadShellCommand(editor, range, shellCommand) {
    if (!shellCommand) {
      return;
    }
    const output = await this.runShellCommand(shellCommand);
    if (output == null) {
      vscode.window.setStatusBarMessage(`mvi :r ! failed: ${shellCommand}`, 2000);
      return;
    }
    const text = output.endsWith("\n") ? output : `${output}\n`;
    const insertLine = Math.min(editor.document.lineCount, range.end + 1);
    const insertPosition = new vscode.Position(insertLine, 0);
    await editor.edit((editBuilder) => {
      editBuilder.insert(insertPosition, text);
    });
    const next = this.normalizeNormalPosition(editor.document, new vscode.Position(Math.min(insertLine, editor.document.lineCount - 1), 0));
    editor.selection = new vscode.Selection(next, next);
  }

  async executeFilterShellCommand(editor, range, shellCommand) {
    if (!shellCommand) {
      return;
    }
    const target = this.lineRange(editor, range.start, range.end);
    const input = editor.document.getText(target);
    const output = await this.runShellCommand(shellCommand, input);
    if (output == null) {
      vscode.window.setStatusBarMessage(`mvi :! failed: ${shellCommand}`, 2000);
      return;
    }
    await editor.edit((editBuilder) => {
      editBuilder.replace(target, output);
    });
    this.jumpToLine(editor, Math.min(range.start, Math.max(0, editor.document.lineCount - 1)));
    if (String(this.mode).startsWith("visual")) {
      await this.setMode("normal");
    }
  }

  async runShellCommand(shellCommand, input = null) {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", shellCommand], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      if (input != null) {
        child.stdin.write(input);
      }
      child.stdin.end();
      child.on("error", () => {
        resolve(null);
      });
      child.on("close", (code) => {
        resolve(code === 0 ? stdout : null);
      });
    });
  }

  resolvePath(editor, fileArg) {
    if (/^\w+:/.test(fileArg)) {
      return vscode.Uri.parse(fileArg);
    }
    const path = require("path");
    return vscode.Uri.file(path.resolve(path.dirname(editor.document.uri.fsPath), fileArg));
  }

  async openEditorPath(editor, fileArg) {
    const target = this.resolvePath(editor, fileArg);
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document);
  }

  async executeReadFile(editor, range, fileArg) {
    if (!fileArg) {
      return;
    }
    const target = this.resolvePath(editor, fileArg);
    const bytes = await vscode.workspace.fs.readFile(target);
    const text = Buffer.from(bytes).toString("utf8");
    const insertLine = Math.min(editor.document.lineCount, range.end + 1);
    await editor.edit((editBuilder) => {
      editBuilder.insert(new vscode.Position(insertLine, 0), text.endsWith("\n") ? text : `${text}\n`);
    });
  }

  argumentList(editor) {
    return vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === "file")
      .map((document) => document.uri)
      .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
  }

  async navigateArguments(editor, direction) {
    const args = this.argumentList(editor);
    const current = args.findIndex((uri) => uri.toString() === editor.document.uri.toString());
    if (current === -1 || !args.length) {
      return;
    }
    const next = (current + direction + args.length) % args.length;
    const document = await vscode.workspace.openTextDocument(args[next]);
    await vscode.window.showTextDocument(document);
  }

  async rewindArguments(editor) {
    const args = this.argumentList(editor);
    if (!args.length) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(args[0]);
    await vscode.window.showTextDocument(document);
  }

  async executePut(editor, line, registerName) {
    if (registerName) {
      this.selectedRegister = registerName;
    }
    await this.pasteRegister(editor, false, 1);
    this.jumpToLine(editor, Math.min(line + 1, editor.document.lineCount - 1));
  }

  async executeCopyRange(editor, range, destination) {
    const text = editor.document.getText(this.lineRange(editor, range.start, range.end));
    const insertPosition = new vscode.Position(Math.min(destination + 1, editor.document.lineCount), 0);
    await editor.edit((editBuilder) => {
      editBuilder.insert(insertPosition, text.endsWith("\n") ? text : `${text}\n`);
    });
  }

  async executeMoveRange(editor, range, destination) {
    const text = editor.document.getText(this.lineRange(editor, range.start, range.end));
    await this.executeDeleteRange(editor, range);
    const insertPosition = new vscode.Position(Math.min(destination + 1, editor.document.lineCount), 0);
    await editor.edit((editBuilder) => {
      editBuilder.insert(insertPosition, text.endsWith("\n") ? text : `${text}\n`);
    });
  }

  showOutput(title, lines) {
    this.outputChannel.clear();
    this.outputChannel.appendLine(title);
    for (const line of lines) {
      this.outputChannel.appendLine(String(line));
    }
    this.outputChannel.show(true);
  }

  showExRange(editor, range, mode) {
    const lines = [];
    for (let line = range.start; line <= range.end; line += 1) {
      let text = editor.document.lineAt(line).text;
      if (mode === "list") {
        text = text.replace(/\t/g, "\\t").replace(/ /g, "·");
      }
      if (mode === "number") {
        text = `${line + 1}\t${text}`;
      }
      lines.push(text);
    }
    this.showOutput(`:${mode}`, lines);
  }

  async executeGlobal(editor, range, ex) {
    const match = ex.match(/^(g|global|v)\/(.*)\/\s*(.*)$/i);
    if (!match) {
      return;
    }
    const invert = /^v/i.test(match[1]);
    const regex = new RegExp(match[2], this.searchFlags());
    const command = match[3] || "print";
    const matchingLines = [];
    for (let line = range.start; line <= range.end; line += 1) {
      const hit = regex.test(editor.document.lineAt(line).text);
      regex.lastIndex = 0;
      if (hit !== invert) {
        matchingLines.push(line);
      }
    }
    if (/^(p|print|l|list|nu|number|#)$/i.test(command)) {
      this.showOutput(":global", matchingLines.map((line) => `${line + 1}\t${editor.document.lineAt(line).text}`));
      return;
    }
    for (let index = matchingLines.length - 1; index >= 0; index -= 1) {
      await this.executeExCommand(editor, `${matchingLines[index] + 1}${command}`);
    }
  }

  async executeSource(editor, fileArg) {
    if (!fileArg) {
      return;
    }
    const target = this.resolvePath(editor, fileArg);
    const bytes = await vscode.workspace.fs.readFile(target);
    const text = Buffer.from(bytes).toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("\"")) {
        continue;
      }
      await this.executeExCommand(editor, trimmed);
    }
  }

  executeShellCommand() {
    const terminal = vscode.window.createTerminal("MVI Shell");
    terminal.show();
  }

  showHelp() {
    this.showOutput("MVI Help", [
      "Supported ex commands:",
      "write, quit, wq, x, edit, read, delete, yank, join, substitute, put, copy, move, print, list, number, global, v, mark, source, shell, help, version, args, next, previous, rewind, tag, tagpop, preserve, recover, set"
    ]);
  }

  showVersion() {
    vscode.window.setStatusBarMessage("MVI 0.0.1", 3000);
  }

  parseExCommand(editor, command) {
    const trimmed = command.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("%")) {
      return {
        range: { start: 0, end: Math.max(0, editor.document.lineCount - 1) },
        command: trimmed.slice(1).trim()
      };
    }
    const first = this.consumeExAddress(editor, trimmed);
    if (!first) {
      return { range: null, command: trimmed };
    }
    let start = first.address;
    let end = first.address;
    let index = first.index;
    if (trimmed[index] === "," || trimmed[index] === ";") {
      const next = this.consumeExAddress(editor, trimmed.slice(index + 1));
      if (next) {
        end = next.address;
        index += 1 + next.index;
      }
    }
    return {
      range: { start: Math.min(start, end), end: Math.max(start, end) },
      command: trimmed.slice(index).trim()
    };
  }

  parseExAddress(editor, token) {
    const consumed = this.consumeExAddress(editor, String(token || "").trim());
    return consumed ? consumed.address : null;
  }

  consumeExAddress(editor, text) {
    const source = String(text || "");
    if (!source) {
      return null;
    }
    let index = 0;
    let base = null;
    if (source.startsWith("'<") || source.startsWith("'>")) {
      const range = this.exSelectionLineRange(editor);
      if (!range) {
        return null;
      }
      base = source.startsWith("'<") ? range.start : range.end;
      index = 2;
    } else if (/^'[A-Za-z]/.test(source)) {
      const mark = this.marks.get(source[1]);
      if (!mark) {
        return null;
      }
      base = mark.line;
      index = 2;
    } else if (source[0] === ".") {
      base = editor.selection.active.line;
      index = 1;
    } else if (source[0] === "$") {
      base = Math.max(0, editor.document.lineCount - 1);
      index = 1;
    } else if (source[0] === "/" || source[0] === "?") {
      const parsed = this.consumeDelimitedPattern(source);
      if (!parsed) {
        return null;
      }
      const position = this.findSearchPosition(editor.document, editor.selection.active, parsed.value, source[0] === "/" ? 1 : -1);
      if (!position) {
        return null;
      }
      base = position.line;
      index = parsed.index;
    } else {
      const number = source.match(/^\d+/);
      if (!number) {
        return null;
      }
      base = Math.max(0, Math.min(editor.document.lineCount - 1, Number(number[0]) - 1));
      index = number[0].length;
    }
    while (true) {
      const offset = source.slice(index).match(/^\s*([+-])\s*(\d*)/);
      if (!offset) {
        break;
      }
      const amount = offset[2] ? Number(offset[2]) : 1;
      base += offset[1] === "+" ? amount : -amount;
      index += offset[0].length;
    }
    base = Math.max(0, Math.min(editor.document.lineCount - 1, base));
    return { address: base, index };
  }

  consumeDelimitedPattern(text) {
    const delimiter = text[0];
    let escaped = false;
    let value = "";
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === delimiter) {
        return { value, index: index + 1 };
      }
      value += char;
    }
    return { value, index: text.length };
  }

  currentLineRange(editor) {
    const line = editor.selection.active.line;
    return { start: line, end: line };
  }

  exVisualRangePrefix(editor) {
    if (!String(this.mode).startsWith("visual")) {
      return "";
    }
    return "'<,'>";
  }

  exSelectionLineRange(editor) {
    if (this.mode === "visual-line" && this.visualAnchor) {
      const { startLine, endLine } = this.visualLineBounds(editor);
      return { start: startLine, end: endLine };
    }
    const selections = editor.selections && editor.selections.length ? editor.selections : [editor.selection];
    const lines = selections
      .filter((selection) => !selection.isEmpty)
      .flatMap((selection) => [selection.start.line, selection.end.line]);
    if (lines.length) {
      return {
        start: Math.min(...lines),
        end: Math.max(...lines)
      };
    }
    if (this.visualAnchor) {
      return {
        start: Math.min(this.visualAnchor.line, editor.selection.active.line),
        end: Math.max(this.visualAnchor.line, editor.selection.active.line)
      };
    }
    return null;
  }

  visualBlockBounds(editor) {
    const anchor = this.visualAnchor;
    const active = this.visualBlockActive || editor.selection.active;
    if (!anchor || !active) {
      return null;
    }
    return {
      startLine: Math.min(anchor.line, active.line),
      endLine: Math.max(anchor.line, active.line),
      startCol: Math.min(anchor.character, this.visualBlockColumn ?? active.character),
      endCol: Math.max(anchor.character, this.visualBlockColumn ?? active.character)
    };
  }

  visualBlockRanges(editor) {
    const bounds = this.visualBlockBounds(editor);
    if (!bounds) {
      return [];
    }
    const ranges = [];
    for (let line = bounds.startLine; line <= bounds.endLine; line += 1) {
      const lineLength = editor.document.lineAt(line).text.length;
      const start = Math.min(bounds.startCol, lineLength);
      const end = Math.min(bounds.endCol + 1, lineLength);
      ranges.push(new vscode.Range(new vscode.Position(line, start), new vscode.Position(line, end)));
    }
    return ranges;
  }

  visualBlockDecorationRanges(editor) {
    const ranges = [];
    for (const range of this.visualBlockRanges(editor)) {
      if (!range.isEmpty) {
        ranges.push(range);
      }
    }
    return { ranges, emptyRanges: [] };
  }

  jumpToLine(editor, line) {
    const next = this.normalizeNormalPosition(editor.document, new vscode.Position(line, 0));
    editor.selection = new vscode.Selection(next, next);
  }

  lineRange(editor, startLine, endLine) {
    const document = editor.document;
    const start = new vscode.Position(startLine, 0);
    if (endLine < document.lineCount - 1) {
      return new vscode.Range(start, new vscode.Position(endLine + 1, 0));
    }
    return new vscode.Range(start, document.lineAt(endLine).range.end);
  }

  async executeDeleteRange(editor, range) {
    const target = this.lineRange(editor, range.start, range.end);
    this.captureDeletedText(editor.document.getText(target), true);
    await editor.edit((editBuilder) => {
      editBuilder.delete(target);
    });
    const nextLine = Math.min(range.start, Math.max(0, editor.document.lineCount - 1));
    this.jumpToLine(editor, nextLine);
  }

  async executeYankRange(editor, range) {
    const target = this.lineRange(editor, range.start, range.end);
    const text = editor.document.getText(target);
    this.writeRegister(text, true);
    this.registers.set("0", { text: text.endsWith("\n") ? text : `${text}\n`, linewise: true });
    this.jumpToLine(editor, range.start);
  }

  async executeJoinRange(editor, range) {
    if (range.end <= range.start) {
      return;
    }
    editor.selection = new vscode.Selection(
      new vscode.Position(range.start, 0),
      new vscode.Position(range.end, editor.document.lineAt(range.end).text.length)
    );
    await vscode.commands.executeCommand("editor.action.joinLines");
    this.jumpToLine(editor, range.start);
  }

  indentationUnit() {
    if (this.options.expandtab) {
      return " ".repeat(Math.max(1, this.options.shiftwidth));
    }
    return "\t";
  }

  outdentText(text) {
    if (text.startsWith("\t")) {
      return text.slice(1);
    }
    const width = Math.max(1, this.options.shiftwidth);
    let count = 0;
    while (count < width && text[count] === " ") {
      count += 1;
    }
    return text.slice(count);
  }

  async shiftLines(editor, direction, count = 1) {
    const line = editor.selection.active.line;
    const endLine = Math.min(editor.document.lineCount - 1, line + Math.max(1, count) - 1);
    await this.shiftLineRange(editor, line, endLine, direction);
  }

  async applyShiftOperator(editor, direction, motion, count = 1) {
    const start = this.currentPosition(editor);
    const end = this.computeMotionTarget(editor.document, start, motion, count);
    await this.shiftLineRange(editor, Math.min(start.line, end.line), Math.max(start.line, end.line), direction);
  }

  async shiftLineRange(editor, startLine, endLine, direction) {
    const replacements = [];
    for (let line = startLine; line <= endLine; line += 1) {
      const text = editor.document.lineAt(line).text;
      replacements.push({
        line,
        text: direction > 0 ? `${this.indentationUnit()}${text}` : this.outdentText(text)
      });
    }
    await editor.edit((editBuilder) => {
      for (const replacement of replacements) {
        editBuilder.replace(editor.document.lineAt(replacement.line).range, replacement.text);
      }
    });
    this.jumpToLine(editor, startLine);
  }

  async executeSubstitute(editor, command, explicitRange = null) {
    const parsed = this.parseSubstituteCommand(command);
    if (!parsed) {
      return;
    }
    const { pattern, replacement, flags } = parsed;
    let regex;
    try {
      regex = new RegExp(pattern, this.searchFlags(flags.includes("g") ? "g" : ""));
    } catch (_error) {
      return;
    }
    const effectiveRange = explicitRange || this.currentLineRange(editor);
    const range = this.lineRange(editor, effectiveRange.start, effectiveRange.end);
    const text = editor.document.getText(range);
    const next = text.replace(regex, replacement);
    if (next === text) {
      return;
    }
    this.lastSubstitute = { pattern, replacement, flags };
    await editor.edit((editBuilder) => {
      editBuilder.replace(range, next);
    });
  }

  parseSubstituteCommand(command) {
    const match = command.match(/^s(.)(.*)$/);
    if (!match) {
      return null;
    }
    const delimiter = match[1];
    const rest = match[2];
    const parts = [];
    let current = "";
    let escaped = false;
    for (const char of rest) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        current += char;
        escaped = true;
        continue;
      }
      if (char === delimiter && parts.length < 2) {
        parts.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    parts.push(current);
    if (parts.length < 3) {
      return null;
    }
    return {
      pattern: parts[0],
      replacement: parts[1].replace(/\\n/g, "\n"),
      flags: parts[2]
    };
  }

  async repeatSearch(editor, directionFactor, count = 1) {
    if (!this.lastSearch) {
      return;
    }
    for (let i = 0; i < Math.max(1, count); i += 1) {
      await this.runSearch(editor, this.lastSearch.pattern, this.lastSearch.direction * directionFactor, { regex: true });
    }
  }

  searchFlags(extra = "") {
    const parts = new Set(extra ? extra.split("") : []);
    if (this.options.ignorecase) {
      parts.add("i");
    }
    parts.add("g");
    return [...parts].join("");
  }

  parseSearchSpec(value, direction) {
    const text = String(value || "").trim();
    if (!text) {
      return this.lastSearch ? { ...this.lastSearch, direction } : null;
    }
    const match = text.match(/^(.*?)(?:\s*([+-]\d+))?(?:\s*z)?$/);
    const raw = match ? match[1] : text;
    return {
      raw,
      pattern: raw,
      direction,
      offset: match && match[2] ? Number(match[2]) : 0
    };
  }

  findSearchPosition(document, start, pattern, direction) {
    const fullText = document.getText();
    let compiled;
    try {
      compiled = new RegExp(pattern, this.searchFlags());
    } catch (_error) {
      return null;
    }
    const currentOffset = document.offsetAt(start);
    let match = null;
    if (direction > 0) {
      compiled.lastIndex = Math.min(fullText.length, currentOffset + 1);
      match = compiled.exec(fullText);
      if (!match && this.options.wrapscan) {
        compiled.lastIndex = 0;
        match = compiled.exec(fullText);
      }
    } else {
      let currentMatch;
      while ((currentMatch = compiled.exec(fullText))) {
        if (currentMatch.index >= currentOffset) {
          break;
        }
        match = currentMatch;
      }
      if (!match && this.options.wrapscan) {
        while ((currentMatch = compiled.exec(fullText))) {
          match = currentMatch;
        }
      }
    }
    return match ? document.positionAt(match.index) : null;
  }

  async executeSetCommand(argument) {
    const text = String(argument || "").trim();
    if (!text) {
      this.showOutput(":set", Object.entries(this.options).map(([key, value]) => `${key}=${value}`));
      return;
    }
    if (text === "all") {
      this.showOutput(":set all", Object.entries(this.options).map(([key, value]) => `${key}=${value}`));
      return;
    }
    const alias = {
      nu: "number",
      ic: "ignorecase",
      ws: "wrapscan",
      smd: "showmode",
      sw: "shiftwidth",
      ts: "tabstop",
      et: "expandtab",
      ai: "autoindent",
      ro: "readonly"
    };
    for (const token of text.split(/\s+/)) {
      if (!token) {
        continue;
      }
      if (token === "spell") {
        this.spellEnabled = true;
        continue;
      }
      if (token === "nospell") {
        this.spellEnabled = false;
        continue;
      }
      if (token === "spell?") {
        vscode.window.setStatusBarMessage(`mvi spell ${this.spellEnabled ? "on" : "off"}`, 2000);
        continue;
      }
      if (token.endsWith("?")) {
        const key = alias[token.slice(0, -1)] || token.slice(0, -1);
        if (key in this.options) {
          vscode.window.setStatusBarMessage(`${key}=${this.options[key]}`, 2000);
        }
        continue;
      }
      if (token.includes("=")) {
        const [rawKey, rawValue] = token.split("=");
        const key = alias[rawKey] || rawKey;
        if (key in this.options) {
          const value = /^\d+$/.test(rawValue) ? Number(rawValue) : rawValue === "true";
          this.options[key] = value;
        }
        continue;
      }
      if (token.startsWith("no")) {
        const key = alias[token.slice(2)] || token.slice(2);
        if (key in this.options) {
          this.options[key] = false;
        }
        continue;
      }
      const key = alias[token] || token;
      if (key in this.options) {
        this.options[key] = true;
      }
    }
    this.updateStatusBar();
  }

  async runSearch(editor, pattern, direction, { regex = true, offset = 0 } = {}) {
    const document = editor.document;
    const fullText = document.getText();
    if (!fullText) {
      return;
    }
    const expression = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let compiled;
    try {
      compiled = new RegExp(expression, this.searchFlags());
    } catch (_error) {
      return;
    }
    const currentOffset = document.offsetAt(editor.selection.active);
    let match = null;
    if (direction > 0) {
      compiled.lastIndex = Math.min(fullText.length, currentOffset + 1);
      match = compiled.exec(fullText);
      if (!match && this.options.wrapscan) {
        compiled.lastIndex = 0;
        match = compiled.exec(fullText);
      }
    } else {
      let currentMatch;
      while ((currentMatch = compiled.exec(fullText))) {
        if (currentMatch.index >= currentOffset) {
          break;
        }
        match = currentMatch;
        if (currentMatch[0].length === 0) {
          compiled.lastIndex += 1;
        }
      }
      if (!match && this.options.wrapscan) {
        while ((currentMatch = compiled.exec(fullText))) {
          match = currentMatch;
          if (currentMatch[0].length === 0) {
            compiled.lastIndex += 1;
          }
        }
      }
    }
    if (!match) {
      return;
    }
    let position = this.normalizeNormalPosition(document, document.positionAt(match.index));
    if (offset) {
      const line = Math.max(0, Math.min(document.lineCount - 1, position.line + offset));
      position = this.normalizeNormalPosition(document, new vscode.Position(line, 0));
    }
    editor.selection = new vscode.Selection(position, position);
    this.refresh(editor);
  }

  async copyCurrentLine(editor, count = 1) {
    const line = editor.selection.active.line;
    const endLine = Math.min(editor.document.lineCount - 1, line + Math.max(1, count) - 1);
    const text = editor.document.getText(this.lineRange(editor, line, endLine));
    this.writeRegister(text, true);
    const normalized = text.endsWith("\n") ? text : `${text}\n`;
    this.registers.set("0", { text: normalized, linewise: true });
  }

  async applyOperatorToMotion(editor, operator, motion, count = 1) {
    const start = this.currentPosition(editor);
    const normalized = this.makeOperatorMotionRange(editor.document, start, operator, motion, count);
    if (!normalized) {
      return;
    }
    editor.selection = new vscode.Selection(normalized.start, normalized.end);
    if (operator === "y") {
      const text = editor.document.getText(new vscode.Range(normalized.start, normalized.end));
      this.writeRegister(text, false);
      this.registers.set("0", { text, linewise: false });
      editor.selection = new vscode.Selection(normalized.start, normalized.start);
      return;
    }
    if (operator === "d") {
      this.captureDeletedText(editor.document.getText(new vscode.Range(normalized.start, normalized.end)), false);
      await editor.edit((editBuilder) => {
        editBuilder.delete(new vscode.Range(normalized.start, normalized.end));
      });
      const next = this.normalizeNormalPosition(editor.document, normalized.start);
      editor.selection = new vscode.Selection(next, next);
      return;
    }
    if (operator === "c") {
      this.captureDeletedText(editor.document.getText(new vscode.Range(normalized.start, normalized.end)), false);
      await editor.edit((editBuilder) => {
        editBuilder.delete(new vscode.Range(normalized.start, normalized.end));
      });
      editor.selection = new vscode.Selection(normalized.start, normalized.start);
      await this.setMode("insert");
    }
  }

  async applyOperatorToFind(editor, operator, motion, key) {
    const start = this.currentPosition(editor);
    const end = this.findMotionTarget(editor.document, start, motion, key);
    if (!end) {
      return;
    }
    this.lastFind = { motion, key };
    const normalized = this.makeOperatorRange(editor.document, start, end);
    if (!normalized) {
      return;
    }
    if (operator === "y") {
      const text = editor.document.getText(new vscode.Range(normalized.start, normalized.end));
      this.writeRegister(text, false);
      this.registers.set("0", { text, linewise: false });
      editor.selection = new vscode.Selection(normalized.start, normalized.start);
      return;
    }
    this.captureDeletedText(editor.document.getText(new vscode.Range(normalized.start, normalized.end)), false);
    await editor.edit((editBuilder) => {
      editBuilder.delete(new vscode.Range(normalized.start, normalized.end));
    });
    editor.selection = new vscode.Selection(normalized.start, normalized.start);
    if (operator === "c") {
      await this.setMode("insert");
    }
  }

  async applyFindKey(editor, motion, key) {
    const target = this.findMotionTarget(editor.document, this.currentPosition(editor), motion, key);
    if (!target) {
      return;
    }
    this.lastFind = { motion, key };
    editor.selection = new vscode.Selection(target, target);
  }

  async repeatFind(editor, reverse, count = 1) {
    if (!this.lastFind) {
      return;
    }
    const motion = reverse ? this.reverseFindMotion(this.lastFind.motion) : this.lastFind.motion;
    for (let i = 0; i < Math.max(1, count); i += 1) {
      await this.applyFindKey(editor, motion, this.lastFind.key);
    }
  }

  reverseFindMotion(motion) {
    switch (motion) {
      case "f": return "F";
      case "F": return "f";
      case "t": return "T";
      case "T": return "t";
      default: return motion;
    }
  }

  findMotionTarget(document, start, motion, needle) {
    const lineText = document.lineAt(start.line).text;
    if (!needle || needle.length !== 1) {
      return null;
    }
    if (motion === "f" || motion === "t") {
      const index = lineText.indexOf(needle, start.character + 1);
      if (index === -1) {
        return null;
      }
      return new vscode.Position(start.line, motion === "t" ? Math.max(start.character, index - 1) : index);
    }
    if (motion === "F" || motion === "T") {
      const sliceEnd = Math.max(0, start.character - 1);
      const index = lineText.lastIndexOf(needle, sliceEnd);
      if (index === -1) {
        return null;
      }
      return new vscode.Position(start.line, motion === "T" ? Math.min(lineText.length, index + 1) : index);
    }
    return null;
  }

  setMark(name, position) {
    if (!/^[A-Za-z]$/.test(name)) {
      return;
    }
    this.marks.set(name, position);
  }

  jumpToMark(editor, name, exact) {
    const target = this.marks.get(name);
    if (!target) {
      return;
    }
    const clamped = this.clampPosition(editor.document, target);
    const position = exact
      ? this.normalizeNormalPosition(editor.document, clamped)
      : this.normalizeNormalPosition(editor.document, new vscode.Position(clamped.line, this.firstNonWhitespace(editor.document.lineAt(clamped.line).text)));
    editor.selection = new vscode.Selection(position, position);
  }

  isSectionBoundary(lineText) {
    return /^\f/u.test(lineText)
      || /^\.[A-Z]{2}\b/u.test(lineText)
      || /^[{]/u.test(lineText);
  }

  previousSectionStart(document, position) {
    for (let line = Math.max(0, position.line - 1); line >= 0; line -= 1) {
      if (this.isSectionBoundary(document.lineAt(line).text)) {
        return new vscode.Position(line, 0);
      }
    }
    return new vscode.Position(0, 0);
  }

  nextSectionStart(document, position) {
    for (let line = Math.min(document.lineCount - 1, position.line + 1); line < document.lineCount; line += 1) {
      if (this.isSectionBoundary(document.lineAt(line).text)) {
        return new vscode.Position(line, 0);
      }
    }
    return new vscode.Position(this.maxNavigableLine(document), 0);
  }

  async repeatLastEdit(editor) {
    if (!this.lastEdit) {
      return;
    }
    switch (this.lastEdit.type) {
      case "deleteChar":
        await this.deleteRight(editor, this.lastEdit.count);
        break;
      case "replaceChar":
        await this.replaceCharacter(editor, this.lastEdit.char, this.lastEdit.count);
        break;
      case "substituteChar":
        await this.substituteCharacter(editor, this.lastEdit.count);
        break;
      case "deleteToLineEnd":
        await this.deleteToLineEnd(editor);
        break;
      case "changeToLineEnd":
        await this.changeToLineEnd(editor);
        break;
      case "changeLine":
        await this.changeCurrentLine(editor, this.lastEdit.count);
        break;
      case "deleteLine":
        await this.deleteCurrentLine(editor, this.lastEdit.count);
        break;
      case "joinLines":
        await vscode.commands.executeCommand("editor.action.joinLines");
        break;
      case "motionDelete":
        await this.applyOperatorToMotion(editor, "d", this.lastEdit.motion, this.lastEdit.count);
        break;
      case "motionChange":
        await this.applyOperatorToMotion(editor, "c", this.lastEdit.motion, this.lastEdit.count);
        break;
      case "insert":
        await this.repeatInsert(editor, this.lastEdit);
        break;
      case "toggleCase":
        await this.toggleCaseAtCursor(editor, this.lastEdit.count);
        break;
      case "deleteLeftChar":
        await vscode.commands.executeCommand("deleteLeft");
        break;
      case "replaceMode":
        await this.setMode("replace");
        break;
      default:
        break;
    }
    this.refresh(editor);
  }

  async repeatLastSubstitute(editor) {
    if (!this.lastSubstitute) {
      return;
    }
    const { pattern, replacement, flags } = this.lastSubstitute;
    await this.executeSubstitute(editor, `s/${pattern}/${replacement}/${flags}`, this.currentLineRange(editor));
    this.refresh(editor);
  }

  async adjustNumberUnderCursor(editor, count = 1, direction = 1) {
    const line = editor.selection.active.line;
    const text = editor.document.lineAt(line).text;
    const cursor = editor.selection.active.character;
    const regex = /[-+]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|\d+)/g;
    let match;
    let target = null;
    while ((match = regex.exec(text))) {
      if (match.index + match[0].length > cursor || match.index >= cursor) {
        target = match;
        break;
      }
    }
    if (!target) {
      return;
    }
    const raw = target[0];
    const delta = Math.max(1, count) * direction;
    let nextValue;
    if (/^[-+]?0[xX]/.test(raw)) {
      nextValue = `${raw.startsWith("-") ? "-" : ""}0x${(parseInt(raw, 16) + delta).toString(16)}`;
    } else if (/^[-+]?0[0-7]+$/.test(raw) && !/^[-+]?0$/.test(raw)) {
      const sign = raw.startsWith("-") ? -1 : 1;
      const value = parseInt(raw, 8) * sign;
      const adjusted = value + delta;
      nextValue = `${adjusted < 0 ? "-" : ""}0${Math.abs(adjusted).toString(8)}`;
    } else {
      nextValue = String(Number(raw) + delta);
    }
    const range = new vscode.Range(line, target.index, line, target.index + raw.length);
    await editor.edit((editBuilder) => {
      editBuilder.replace(range, nextValue);
    });
    const next = new vscode.Position(line, target.index);
    editor.selection = new vscode.Selection(next, next);
    this.refresh(editor);
  }

  startMacroRecording(name) {
    if (!/^[A-Za-z0-9"]$/.test(name)) {
      return;
    }
    this.recordingMacroRegister = /^[A-Z]$/.test(name) ? name.toLowerCase() : name;
    this.registers.set(this.recordingMacroRegister, { events: [] });
    this.statusBar.text = this.formatStatusBarText(`@${this.recordingMacroRegister}`, "recording");
  }

  stopMacroRecording() {
    this.recordingMacroRegister = null;
    this.statusBar.text = this.formatStatusBarText();
  }

  async playMacro(editor, name, count = 1) {
    const registerName = name === "@" ? this.lastMacroRegister : name;
    if (!registerName) {
      return;
    }
    const macro = this.registers.get(registerName);
    if (!macro || !Array.isArray(macro.events)) {
      return;
    }
    this.lastMacroRegister = registerName;
    this.isPlayingMacro = true;
    try {
      for (let i = 0; i < Math.max(1, count); i += 1) {
        for (const event of macro.events) {
          await this.dispatchMacroEvent(editor, event);
        }
      }
    } finally {
      this.isPlayingMacro = false;
    }
  }

  async dispatchMacroEvent(editor, event) {
    if (!event) {
      return;
    }
    if (event.type === "type") {
      await vscode.commands.executeCommand("default:type", { text: event.text || "" });
      return;
    }
    if (event.type === "backspace") {
      await vscode.commands.executeCommand("deleteLeft");
      return;
    }
    if (event.type === "escape") {
      await this.handleEscape();
      return;
    }
    if (event.type === "key") {
      await this.handleNormalInput(editor, event.key);
    }
  }

  selectRegister(name) {
    this.pendingRegister = false;
    if (!/^[A-Za-z0-9"]$/.test(name)) {
      return;
    }
    this.selectedRegister = name;
  }

  activeRegisterName() {
    return this.selectedRegister || "\"";
  }

  clearSelectedRegister() {
    this.selectedRegister = "\"";
  }

  writeRegister(text, linewise) {
    const normalizedText = linewise && text && !text.endsWith("\n") ? `${text}\n` : text;
    const name = this.activeRegisterName();
    const append = /^[A-Z]$/.test(name);
    const targetName = append ? name.toLowerCase() : name;
    const existing = append ? (this.registers.get(targetName) || { text: "", linewise: !!linewise }) : null;
    const entry = append
      ? { text: `${existing.text}${normalizedText}`, linewise: existing.linewise || !!linewise }
      : { text: normalizedText, linewise: !!linewise };
    this.registers.set(targetName, entry);
    this.registers.set("\"", entry);
    if (/^[1-9]$/.test(targetName) || targetName === "0") {
      this.registers.set(targetName, entry);
    }
    this.clearSelectedRegister();
  }

  captureDeletedText(text, linewise) {
    const normalizedText = linewise && text && !text.endsWith("\n") ? `${text}\n` : text;
    for (let i = 9; i >= 2; i -= 1) {
      const prev = this.registers.get(String(i - 1));
      if (prev) {
        this.registers.set(String(i), prev);
      }
    }
    const entry = { text: normalizedText, linewise: !!linewise };
    this.registers.set("1", entry);
    const selected = this.activeRegisterName();
    const targetName = /^[A-Z]$/.test(selected) ? selected.toLowerCase() : selected;
    if (selected !== "\"") {
      this.registers.set(targetName, entry);
    }
    this.registers.set("\"", entry);
    this.clearSelectedRegister();
  }

  readRegister() {
    return this.registers.get(this.activeRegisterName()) || this.registers.get("\"") || { text: "", linewise: false };
  }

  async pasteRegister(editor, before, count = 1) {
    const entry = this.readRegister();
    this.clearSelectedRegister();
    if (!entry.text) {
      return;
    }
    const active = this.currentPosition(editor);
    const repeatedText = entry.text.repeat(Math.max(1, count));
    if (entry.linewise) {
      const insertLine = before ? active.line : active.line + 1;
      const insertPosition = new vscode.Position(Math.min(insertLine, editor.document.lineCount), 0);
      await editor.edit((editBuilder) => {
        editBuilder.insert(insertPosition, repeatedText);
      });
      const targetLine = Math.min(insertLine, editor.document.lineCount - 1);
      const next = this.normalizeNormalPosition(editor.document, new vscode.Position(Math.max(0, targetLine), 0));
      editor.selection = new vscode.Selection(next, next);
      return;
    }
    const insertAt = before ? active : new vscode.Position(active.line, Math.min(active.character + 1, editor.document.lineAt(active.line).text.length));
    await editor.edit((editBuilder) => {
      editBuilder.insert(insertAt, repeatedText);
    });
    const next = this.normalizeNormalPosition(editor.document, insertAt);
    editor.selection = new vscode.Selection(next, next);
  }

  async yankSelection(editor) {
    if (this.mode === "visual-line") {
      const { startLine, endLine } = this.visualLineBounds(editor);
      const text = editor.document.getText(this.lineRange(editor, startLine, endLine));
      this.writeRegister(text, true);
      this.registers.set("0", { text: text.endsWith("\n") ? text : `${text}\n`, linewise: true });
      return;
    }
    if (this.mode === "visual-block") {
      const ranges = this.visualBlockRanges(editor);
      const text = ranges.map((range) => editor.document.getText(range)).join("\n");
      this.writeRegister(text, false);
      this.registers.set("0", { text, linewise: false });
      return;
    }
    const selections = editor.selections && editor.selections.length ? editor.selections : [editor.selection];
    const text = selections.map((selection) => editor.document.getText(new vscode.Range(selection.start, selection.end))).join("\n");
    this.writeRegister(text, false);
    this.registers.set("0", { text, linewise: false });
  }

  async deleteSelection(editor) {
    if (this.mode === "visual-line") {
      const { startLine, endLine } = this.visualLineBounds(editor);
      const target = this.lineRange(editor, startLine, endLine);
      this.captureDeletedText(editor.document.getText(target), true);
      await editor.edit((editBuilder) => {
        editBuilder.delete(target);
      });
      const next = this.normalizeNormalPosition(editor.document, new vscode.Position(Math.min(startLine, editor.document.lineCount - 1), 0));
      editor.selection = new vscode.Selection(next, next);
      return;
    }
    if (this.mode === "visual-block") {
      const ranges = this.visualBlockRanges(editor);
      const text = ranges.map((range) => editor.document.getText(range)).join("\n");
      this.captureDeletedText(text, false);
      await editor.edit((editBuilder) => {
        for (const range of ranges) {
          if (!range.isEmpty) {
            editBuilder.delete(range);
          }
        }
      });
      const next = this.normalizeNormalPosition(editor.document, new vscode.Position(ranges[0]?.start.line || 0, ranges[0]?.start.character || 0));
      editor.selection = new vscode.Selection(next, next);
      return;
    }
    const selections = editor.selections && editor.selections.length ? editor.selections : [editor.selection];
    const text = selections.map((selection) => editor.document.getText(new vscode.Range(selection.start, selection.end))).join("\n");
    this.captureDeletedText(text, false);
    await editor.edit((editBuilder) => {
      for (const selection of selections) {
        editBuilder.delete(new vscode.Range(selection.start, selection.end));
      }
    });
    const next = this.normalizeNormalPosition(editor.document, selections[0].start);
    editor.selection = new vscode.Selection(next, next);
  }

  async toggleCaseInSelections(editor) {
    if (this.mode === "visual-block") {
      const replacements = [];
      const ranges = this.visualBlockRanges(editor);
      for (const range of ranges) {
        const text = editor.document.getText(range);
        if (!text) {
          continue;
        }
        const toggled = Array.from(text, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");
        replacements.push({ range, text: toggled });
      }
      if (!replacements.length) {
        return;
      }
      await editor.edit((editBuilder) => {
        for (const replacement of replacements) {
          editBuilder.replace(replacement.range, replacement.text);
        }
      });
      const next = this.normalizeNormalPosition(editor.document, replacements[0].range.start);
      editor.selection = new vscode.Selection(next, next);
      return;
    }
    const selections = editor.selections && editor.selections.length ? editor.selections : [editor.selection];
    const replacements = [];
    for (const selection of selections) {
      const range = new vscode.Range(selection.start, selection.end);
      const text = editor.document.getText(range);
      if (!text) {
        continue;
      }
      const toggled = Array.from(text, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");
      replacements.push({ range, text: toggled });
    }
    if (!replacements.length) {
      return;
    }
    await editor.edit((editBuilder) => {
      for (const replacement of replacements) {
        editBuilder.replace(replacement.range, replacement.text);
      }
    });
    const next = this.normalizeNormalPosition(editor.document, selections[0].start);
    editor.selection = new vscode.Selection(next, next);
  }

  async applyTextObject(editor, operator, kind, objectKey) {
    const range = this.textObjectRange(editor.document, this.currentPosition(editor), kind, objectKey);
    if (!range) {
      return;
    }
    if (operator === "y") {
      this.writeRegister(editor.document.getText(range), false);
      editor.selection = new vscode.Selection(range.start, range.start);
      return;
    }
    this.captureDeletedText(editor.document.getText(range), false);
    await editor.edit((editBuilder) => {
      editBuilder.delete(range);
    });
    editor.selection = new vscode.Selection(range.start, range.start);
    if (operator === "c") {
      await this.setMode("insert");
    }
  }

  textObjectRange(document, position, kind, objectKey) {
    if (objectKey === "w") {
      return this.wordTextObjectRange(document, position, kind === "a");
    }
    if (objectKey === "s") {
      return this.sentenceTextObjectRange(document, position, kind === "a");
    }
    if (objectKey === "p") {
      return this.paragraphTextObjectRange(document, position, kind === "a");
    }
    if (objectKey === "\"" || objectKey === "'" || objectKey === "`") {
      return this.quotedTextObjectRange(document, position, kind === "a", objectKey);
    }
    if (["(", ")", "[", "]", "{", "}", "<", ">", "b", "B"].includes(objectKey)) {
      return this.delimitedTextObjectRange(document, position, kind === "a", objectKey);
    }
    return null;
  }

  wordTextObjectRange(document, position, around) {
    const lineText = document.lineAt(position.line).text;
    if (!lineText.length) {
      return null;
    }
    let start = Math.min(position.character, Math.max(0, lineText.length - 1));
    while (start > 0 && this.isWordCharacter(lineText[start - 1])) {
      start -= 1;
    }
    let end = Math.min(lineText.length, Math.max(start, position.character));
    while (end < lineText.length && this.isWordCharacter(lineText[end])) {
      end += 1;
    }
    if (end === start && !this.isWordCharacter(lineText[start])) {
      return null;
    }
    if (around) {
      while (start > 0 && /\s/.test(lineText[start - 1])) {
        start -= 1;
      }
      while (end < lineText.length && /\s/.test(lineText[end])) {
        end += 1;
      }
    }
    return new vscode.Range(position.line, start, position.line, end);
  }

  quotedTextObjectRange(document, position, around, quote) {
    const lineText = document.lineAt(position.line).text;
    const cursor = Math.min(position.character, Math.max(0, lineText.length - 1));
    const left = lineText.lastIndexOf(quote, cursor);
    const right = lineText.indexOf(quote, cursor === left ? cursor + 1 : cursor);
    if (left === -1 || right === -1 || right <= left) {
      return null;
    }
    return around
      ? new vscode.Range(position.line, left, position.line, right + 1)
      : new vscode.Range(position.line, left + 1, position.line, right);
  }

  delimitedTextObjectRange(document, position, around, objectKey) {
    const pairs = {
      "(": ["(", ")"],
      ")": ["(", ")"],
      "b": ["(", ")"],
      "[": ["[", "]"],
      "]": ["[", "]"],
      "{": ["{", "}"],
      "}": ["{", "}"],
      "B": ["{", "}"],
      "<": ["<", ">"],
      ">": ["<", ">"]
    };
    const [open, close] = pairs[objectKey] || [];
    if (!open || !close) {
      return null;
    }
    const lineText = document.lineAt(position.line).text;
    const cursor = Math.min(position.character, Math.max(0, lineText.length - 1));
    let depth = 0;
    let left = -1;
    for (let i = cursor; i >= 0; i -= 1) {
      const char = lineText[i];
      if (char === close) {
        depth += 1;
      } else if (char === open) {
        if (depth === 0) {
          left = i;
          break;
        }
        depth -= 1;
      }
    }
    if (left === -1) {
      return null;
    }
    depth = 0;
    let right = -1;
    for (let i = left + 1; i < lineText.length; i += 1) {
      const char = lineText[i];
      if (char === open) {
        depth += 1;
      } else if (char === close) {
        if (depth === 0) {
          right = i;
          break;
        }
        depth -= 1;
      }
    }
    if (right === -1) {
      return null;
    }
    return around
      ? new vscode.Range(position.line, left, position.line, right + 1)
      : new vscode.Range(position.line, left + 1, position.line, right);
  }

  paragraphTextObjectRange(document, position, around) {
    const isBlank = (line) => /^\s*$/.test(document.lineAt(line).text);
    let startLine = position.line;
    let endLine = position.line;
    const currentBlank = isBlank(position.line);

    while (startLine > 0 && isBlank(startLine - 1) === currentBlank) {
      startLine -= 1;
    }
    while (endLine < document.lineCount - 1 && isBlank(endLine + 1) === currentBlank) {
      endLine += 1;
    }

    if (!around && currentBlank) {
      return null;
    }

    if (around) {
      while (startLine > 0 && isBlank(startLine - 1)) {
        startLine -= 1;
      }
      while (endLine < document.lineCount - 1 && isBlank(endLine + 1)) {
        endLine += 1;
      }
    }

    const start = new vscode.Position(startLine, 0);
    const end = endLine < document.lineCount - 1
      ? new vscode.Position(endLine + 1, 0)
      : document.lineAt(endLine).range.end;
    return new vscode.Range(start, end);
  }

  sentenceTextObjectRange(document, position, around) {
    const start = this.previousSentenceStart(document, position);
    let end = this.nextSentenceStart(document, start);
    if (end.isEqual(start)) {
      const lastLine = document.lineCount - 1;
      end = document.lineAt(lastLine).range.end;
    }
    let rangeStart = start;
    let rangeEnd = end;
    if (around) {
      rangeStart = this.expandRangeBackwardOverWhitespace(document, rangeStart);
      rangeEnd = this.expandRangeForwardOverWhitespace(document, rangeEnd);
    } else {
      rangeStart = this.skipWhitespaceForward(document, rangeStart);
      rangeEnd = this.trimWhitespaceBackward(document, rangeEnd);
    }
    if (rangeEnd.isBeforeOrEqual(rangeStart)) {
      return null;
    }
    return new vscode.Range(rangeStart, rangeEnd);
  }

  async repeatInsert(editor, edit) {
    await this.prepareInsertReplay(editor, edit.insert);
    await this.setMode("insert");
    if (edit.text) {
      await vscode.commands.executeCommand("default:type", { text: edit.text });
    }
    await this.handleEscape();
  }

  async prepareInsertReplay(editor, insertKind) {
    switch (insertKind) {
      case "after":
        this.moveRightForAppend(editor);
        break;
      case "lineStart":
        this.moveToFirstNonWhitespace(editor);
        break;
      case "lineEnd":
        this.moveToLineEnd(editor);
        break;
      case "openBelow":
        await vscode.commands.executeCommand("editor.action.insertLineAfter");
        break;
      case "openAbove":
        await vscode.commands.executeCommand("editor.action.insertLineBefore");
        break;
      case "before":
      default:
        break;
    }
  }

  computeMotionTarget(document, start, motion, count = 1) {
    switch (motion) {
      case "h":
      case "j":
      case "k":
      case "l":
      case "w":
      case "b":
      case "e":
      case "W":
      case "B":
      case "E":
      case "(":
      case ")":
      case "{":
      case "}":
      case " ":
      case "+":
      case "-":
      case "_":
      case "|":
      case "G":
      case "[[":
      case "]]":
      case "ge":
      case "0":
      case "^":
      case "$":
      case "%":
      case "H":
      case "M":
      case "L":
      case "f":
      case "F":
      case "t":
      case "T": {
        const editor = { document, selection: new vscode.Selection(start, start) };
        if (["f", "F", "t", "T"].includes(motion)) {
          if (!this.lastFind) {
            return start;
          }
          return this.findMotionTarget(document, start, motion, this.lastFind.key) || start;
        }
        this.move(editor, motion, false, count);
        return editor.selection.active;
      }
      default:
        return start;
    }
  }

  makeOperatorMotionRange(document, start, operator, motion, count = 1) {
    const effectiveMotion = operator === "c" && motion === "w"
      ? "e"
      : operator === "c" && motion === "W"
        ? "E"
        : motion;
    const end = this.computeMotionTarget(document, start, effectiveMotion, count);
    return this.makeOperatorRange(document, start, end);
  }

  makeOperatorRange(document, start, end) {
    if (start.isEqual(end)) {
      if (end.character >= document.lineAt(end.line).text.length) {
        return null;
      }
      return {
        start,
        end: end.translate(0, 1)
      };
    }
    if (end.isBefore(start)) {
      return {
        start: end,
        end: start
      };
    }
    if (end.character === document.lineAt(end.line).text.length) {
      return { start, end };
    }
    return {
      start,
      end: end.translate(0, 1)
    };
  }

  collapseToSelectionStart(editor, position = null) {
    const start = this.normalizeNormalPosition(editor.document, position || editor.selection.start);
    editor.selections = [new vscode.Selection(start, start)];
    this.refresh(editor);
  }

  firstNonWhitespace(text) {
    const match = text.match(/\S/);
    return match ? match.index : 0;
  }

  isWordCharacter(char) {
    return /\w/.test(char);
  }

  isBigWordCharacter(char) {
    return Boolean(char) && !/\s/.test(char);
  }

  wordEnd(document, position) {
    let line = position.line;
    let character = position.character;
    while (line < document.lineCount) {
      const text = document.lineAt(line).text;
      while (character < text.length && !this.isWordCharacter(text[character])) {
        character += 1;
      }
      if (character < text.length) {
        while (character + 1 < text.length && this.isWordCharacter(text[character + 1])) {
          character += 1;
        }
        return new vscode.Position(line, character);
      }
      line += 1;
      character = 0;
    }
    const lastLine = document.lineCount - 1;
    return this.normalizeNormalPosition(document, new vscode.Position(lastLine, document.lineAt(lastLine).text.length));
  }

  previousWordEnd(document, position) {
    let line = position.line;
    let character = Math.max(0, position.character - 1);
    while (line >= 0) {
      const text = document.lineAt(line).text;
      while (character >= 0 && !this.isWordCharacter(text[character])) {
        character -= 1;
      }
      if (character >= 0) {
        return new vscode.Position(line, character);
      }
      line -= 1;
      if (line >= 0) {
        character = document.lineAt(line).text.length - 1;
      }
    }
    return new vscode.Position(0, 0);
  }

  nextWordStart(document, position) {
    let line = position.line;
    let character = position.character + 1;
    while (line < document.lineCount) {
      const text = document.lineAt(line).text;
      for (; character < text.length; character += 1) {
        const current = text[character];
        const previous = character > 0 ? text[character - 1] : " ";
        if (this.isWordCharacter(current) && !this.isWordCharacter(previous)) {
          return new vscode.Position(line, character);
        }
      }
      line += 1;
      character = 0;
    }
    const lastLine = document.lineCount - 1;
    return new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
  }

  previousWordStart(document, position) {
    let line = position.line;
    let character = Math.max(0, position.character - 1);
    while (line >= 0) {
      const text = document.lineAt(line).text;
      for (; character >= 0; character -= 1) {
        const current = text[character];
        const previous = character > 0 ? text[character - 1] : " ";
        if (this.isWordCharacter(current) && !this.isWordCharacter(previous)) {
          return new vscode.Position(line, character);
        }
      }
      line -= 1;
      if (line >= 0) {
        character = document.lineAt(line).text.length - 1;
      }
    }
    return new vscode.Position(0, 0);
  }

  nextBigWordStart(document, position) {
    let line = position.line;
    let character = position.character + 1;
    while (line < document.lineCount) {
      const text = document.lineAt(line).text;
      for (; character < text.length; character += 1) {
        const current = text[character];
        const previous = character > 0 ? text[character - 1] : " ";
        if (this.isBigWordCharacter(current) && !this.isBigWordCharacter(previous)) {
          return new vscode.Position(line, character);
        }
      }
      line += 1;
      character = 0;
    }
    const lastLine = document.lineCount - 1;
    return new vscode.Position(lastLine, document.lineAt(lastLine).text.length);
  }

  previousBigWordStart(document, position) {
    let line = position.line;
    let character = Math.max(0, position.character - 1);
    while (line >= 0) {
      const text = document.lineAt(line).text;
      for (; character >= 0; character -= 1) {
        const current = text[character];
        const previous = character > 0 ? text[character - 1] : " ";
        if (this.isBigWordCharacter(current) && !this.isBigWordCharacter(previous)) {
          return new vscode.Position(line, character);
        }
      }
      line -= 1;
      if (line >= 0) {
        character = document.lineAt(line).text.length - 1;
      }
    }
    return new vscode.Position(0, 0);
  }

  bigWordEnd(document, position) {
    let line = position.line;
    let character = position.character;
    while (line < document.lineCount) {
      const text = document.lineAt(line).text;
      while (character < text.length && !this.isBigWordCharacter(text[character])) {
        character += 1;
      }
      if (character < text.length) {
        while (character + 1 < text.length && this.isBigWordCharacter(text[character + 1])) {
          character += 1;
        }
        return new vscode.Position(line, character);
      }
      line += 1;
      character = 0;
    }
    const lastLine = document.lineCount - 1;
    return this.normalizeNormalPosition(document, new vscode.Position(lastLine, document.lineAt(lastLine).text.length));
  }

  previousSentenceStart(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    let index = Math.max(0, offset - 1);
    while (index > 0 && /\s/.test(text[index])) {
      index -= 1;
    }
    for (; index > 0; index -= 1) {
      if (this.isSentenceBoundary(text, index)) {
        return this.skipWhitespaceForward(document, document.positionAt(index + 1));
      }
    }
    return this.skipWhitespaceForward(document, new vscode.Position(0, 0));
  }

  nextSentenceStart(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    for (let index = Math.max(0, offset); index < text.length; index += 1) {
      if (this.isSentenceBoundary(text, index)) {
        return this.skipWhitespaceForward(document, document.positionAt(index + 1));
      }
    }
    const lastLine = document.lineCount - 1;
    return document.lineAt(lastLine).range.end;
  }

  isSentenceBoundary(text, index) {
    const char = text[index];
    if (!/[.!?]/.test(char)) {
      return false;
    }
    const next = text[index + 1] || "";
    return next === "" || /\s/.test(next);
  }

  skipWhitespaceForward(document, position) {
    const text = document.getText();
    let offset = document.offsetAt(position);
    while (offset < text.length && /\s/.test(text[offset])) {
      offset += 1;
    }
    return document.positionAt(offset);
  }

  trimWhitespaceBackward(document, position) {
    const text = document.getText();
    let offset = document.offsetAt(position);
    while (offset > 0 && /\s/.test(text[offset - 1])) {
      offset -= 1;
    }
    return document.positionAt(offset);
  }

  expandRangeBackwardOverWhitespace(document, position) {
    const text = document.getText();
    let offset = document.offsetAt(position);
    while (offset > 0 && /\s/.test(text[offset - 1])) {
      offset -= 1;
    }
    return document.positionAt(offset);
  }

  expandRangeForwardOverWhitespace(document, position) {
    const text = document.getText();
    let offset = document.offsetAt(position);
    while (offset < text.length && /\s/.test(text[offset])) {
      offset += 1;
    }
    return document.positionAt(offset);
  }

  previousParagraphStart(document, position) {
    let line = Math.max(0, position.line - 1);
    while (line > 0 && /^\s*$/.test(document.lineAt(line).text)) {
      line -= 1;
    }
    while (line > 0 && !/^\s*$/.test(document.lineAt(line - 1).text)) {
      line -= 1;
    }
    return new vscode.Position(line, 0);
  }

  nextParagraphStart(document, position) {
    let line = Math.min(document.lineCount - 1, position.line + 1);
    while (line < document.lineCount - 1 && !/^\s*$/.test(document.lineAt(line).text)) {
      line += 1;
    }
    while (line < document.lineCount - 1 && /^\s*$/.test(document.lineAt(line).text)) {
      line += 1;
    }
    return new vscode.Position(line, 0);
  }

  matchingBracketRange(document, position) {
    const target = this.findMatchingBracket(document, position);
    if (!target) {
      return null;
    }
    return new vscode.Range(target, target.translate(0, 1));
  }

  findMatchingBracket(document, position) {
    const pairs = {
      "(": ")",
      ")": "(",
      "[": "]",
      "]": "[",
      "{": "}",
      "}": "{"
    };
    const openers = new Set(["(", "[", "{"]);
    const text = document.getText();
    const startOffset = document.offsetAt(position);
    const char = text[startOffset];
    const counterpart = pairs[char];
    if (!counterpart) {
      return null;
    }
    const direction = openers.has(char) ? 1 : -1;
    let depth = 0;
    for (let offset = startOffset; direction > 0 ? offset < text.length : offset >= 0; offset += direction) {
      const current = text[offset];
      if (current === char) {
        depth += 1;
      } else if (current === counterpart) {
        depth -= 1;
        if (depth === 0) {
          return document.positionAt(offset);
        }
      }
    }
    return null;
  }

  matchPair(document, position) {
    return this.findMatchingBracket(document, position) || position;
  }

  viewportMotion(editor, which) {
    const visible = editor.visibleRanges && editor.visibleRanges[0];
    if (!visible) {
      return this.currentPosition(editor);
    }
    let line;
    if (which === "top") {
      line = visible.start.line;
    } else if (which === "bottom") {
      line = visible.end.line;
    } else {
      line = Math.floor((visible.start.line + visible.end.line) / 2);
    }
    const character = this.firstNonWhitespace(editor.document.lineAt(line).text);
    return new vscode.Position(line, character);
  }

  async toggleCaseAtCursor(editor, count = 1) {
    const active = this.currentPosition(editor);
    const lineText = editor.document.lineAt(active.line).text;
    if (!lineText.length || active.character >= lineText.length) {
      return;
    }
    const width = Math.min(Math.max(1, count), lineText.length - active.character);
    const slice = lineText.slice(active.character, active.character + width);
    const toggled = Array.from(slice, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");
    await editor.edit((editBuilder) => {
      editBuilder.replace(new vscode.Range(active, active.translate(0, width)), toggled);
    });
    editor.selection = new vscode.Selection(active, active);
  }

  dispose() {
    this.clearDecorations();
    this.clearSpellDecorations();
    for (const editor of vscode.window.visibleTextEditors) {
      this.restoreCursorStyle(editor);
    }
    this.statusBar.dispose();
    this.exStatusBar.dispose();
    this.outputChannel.dispose();
    this.normalCursorDecoration.dispose();
    this.normalEmptyCursorDecoration.dispose();
    this.visualLineDecoration.dispose();
    this.visualLineEmptyDecoration.dispose();
    this.cursorLineDecoration.dispose();
  }
}

let controller = null;

async function activate(context) {
  controller = new MviController(context);
  const config = vscode.workspace.getConfiguration();
  const autoEnable = config.get("mvijs.autoEnable", true);

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.enable", async () => {
    await controller.enable();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.disable", async () => {
    await controller.disable();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.escape", async () => {
    await controller.handleEscape();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.backspace", async () => {
    await controller.handleBackspace();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.enter", async () => {
    await controller.handleEnter();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.visualBlock", async () => {
    await controller.handleVisualBlockCommand();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.pageDown", async () => {
    await controller.handlePageMove(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.pageUp", async () => {
    await controller.handlePageMove(false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.scrollHalfPageDown", async () => {
    await controller.handleHalfPageScroll(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.scrollHalfPageUp", async () => {
    await controller.handleHalfPageScroll(false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.scrollLineDown", async () => {
    await controller.handleLineScroll(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.scrollLineUp", async () => {
    await controller.handleLineScroll(false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.refreshScreen", async () => {
    await controller.handleScreenRefresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.fileInfo", async () => {
    await controller.handleFileInfo();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.searchWordForward", async () => {
    await controller.handleSearchWordForward();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.tagJump", async () => {
    await controller.handleTagJump();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.tagPop", async () => {
    await controller.handleTagPop();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.alternateFile", async () => {
    await controller.handleAlternateFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.windowCommand", async () => {
    await controller.handleWindowCommand();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.suspendCommand", async () => {
    await controller.handleSuspendCommand();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("type", async (args) => {
    if (!controller || !controller.enabled) {
      return vscode.commands.executeCommand("default:type", args);
    }
    return controller.handleType(args && args.text ? args.text : "");
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!controller || !controller.enabled) {
      return;
    }
    controller.trackActiveEditor(editor || undefined);
    controller.refresh(editor || undefined);
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!controller || !controller.enabled || !controller.isActiveEditor(event.textEditor)) {
      return;
    }
    controller.maybeUpdateTrackedLineState(event.textEditor);
    controller.refresh(event.textEditor);
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (!controller || !controller.enabled || !controller.isActiveEditor(event.textEditor)) {
      return;
    }
    controller.refresh(event.textEditor);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller || !controller.enabled) {
      return;
    }
    controller.handleDocumentChange(event);
  }));

  context.subscriptions.push(controller);
  await vscode.commands.executeCommand("setContext", ENABLED_CONTEXT_KEY, false);
  await vscode.commands.executeCommand("setContext", MODE_CONTEXT_KEY, "normal");
  if (autoEnable) {
    await controller.enable();
  }
}

function deactivate() {
  if (controller) {
    controller.dispose();
    controller = null;
  }
}

module.exports = { activate, deactivate };
