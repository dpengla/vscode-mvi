const vscode = require("vscode");
const { spawn } = require("child_process");

const MODE_CONTEXT_KEY = "mvijs.mode";
const ENABLED_CONTEXT_KEY = "mvijs.enabled";

class NativeMviController {
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
    this.savedCursorStyles = new WeakMap();
    this.spellEnabled = false;
    this.spellProgram = "/opt/homebrew/bin/aspell";
    this.spellRefreshTimer = null;
    this.spellRequestId = 0;
    this.registers = new Map([["\"", { text: "", linewise: false }]]);
    this.selectedRegister = "\"";
    this.pendingRegister = false;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = "MVI Mode";
    this.statusBar.command = "mvijs.disableNativeEditor";
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
    this.cursorLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.lineHighlightBackground")
    });
    this.spellErrorDecoration = vscode.window.createTextEditorDecorationType({
      textDecoration: "underline wavy var(--vscode-editorError-foreground)",
      overviewRulerColor: new vscode.ThemeColor("editorError.foreground")
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
    await this.setMode("normal");
    this.statusBar.show();
    this.refresh();
  }

  async disable() {
    this.enabled = false;
    this.pendingOperator = null;
    this.visualAnchor = null;
    this.clearPendingCounts();
    await this.setContext(ENABLED_CONTEXT_KEY, false);
    await this.setMode("normal");
    this.clearDecorations();
    this.clearSpellDecorations();
    this.statusBar.hide();
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
    if (mode !== "normal") {
      this.clearPendingCounts();
    }
    await this.setContext(MODE_CONTEXT_KEY, mode);
    this.statusBar.text = `MVI ${mode.toUpperCase()}${this.spellEnabled ? " SPELL" : ""}`;
    this.refresh();
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
    if (!this.savedCursorStyles.has(editor)) {
      this.savedCursorStyles.set(editor, editor.options.cursorStyle);
    }
    if (editor.options.cursorStyle !== style) {
      editor.options = {
        ...editor.options,
        cursorStyle: style
      };
    }
  }

  restoreCursorStyle(editor) {
    if (!editor || !this.savedCursorStyles.has(editor)) {
      return;
    }
    const saved = this.savedCursorStyles.get(editor);
    if (editor.options.cursorStyle !== saved) {
      editor.options = {
        ...editor.options,
        cursorStyle: saved
      };
    }
  }

  desiredCursorStyle() {
    if (this.mode === "normal" || this.mode === "visual-line") {
      return vscode.TextEditorCursorStyle.Block;
    }
    if (String(this.mode).startsWith("visual")) {
      return vscode.TextEditorCursorStyle.LineThin;
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
    } else {
      editor.setDecorations(this.cursorLineDecoration, [new vscode.Range(active.line, 0, active.line, 0)]);
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
    if (this.mode === "insert") {
      this.recordMacroEvent({ type: "type", text });
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
    if (this.mode === "insert") {
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
    this.pendingOperator = null;
    this.pendingRegister = false;
    this.clearPendingCounts();
    if (this.mode === "insert") {
      this.recordMacroEvent({ type: "escape" });
      const active = this.normalPositionFromInsert(editor.document, editor.selection.active);
      editor.selection = new vscode.Selection(active, active);
    }
    await this.setMode("normal");
  }

  async handleVisualBlockCommand() {
    const editor = this.getEditor();
    if (!editor) {
      return;
    }
    if (this.mode === "visual-block") {
      await this.setMode("normal");
      this.collapseToSelectionStart(editor);
      return;
    }
    await this.enterVisualBlock(editor);
    this.refresh(editor);
  }

  rememberEdit(edit) {
    this.lastEdit = edit || null;
  }

  async setSpellEnabled(editor, enabled) {
    this.spellEnabled = !!enabled;
    if (!this.spellEnabled) {
      this.clearSpellDecorations();
    }
    this.statusBar.text = `MVI ${this.mode.toUpperCase()}${this.spellEnabled ? " SPELL" : ""}`;
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
    this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${this.pendingCount}`;
  }

  consumeCount() {
    const count = this.pendingCount ? Number(this.pendingCount) : 1;
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

  async handleNormalInput(editor, key) {
    if (String(this.mode).startsWith("visual")) {
      await this.handleVisualInput(editor, key);
      return;
    }
    if (this.pendingRegister) {
      this.recordMacroEvent({ type: "key", key });
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
        this.recordMacroEvent({ type: "key", key });
        this.pushCountDigit(key);
        return;
      }
      if (!(this.pendingOperator && typeof this.pendingOperator === "object" && ["record-macro", "play-macro"].includes(this.pendingOperator.type))) {
        this.recordMacroEvent({ type: "key", key });
      }
      await this.resolveOperator(editor, key);
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
      case "0":
      case "^":
      case "$":
      case "%":
      case "H":
      case "M":
      case "L":
        this.move(editor, key, false, this.consumeCount());
        this.refresh(editor);
        return;
      case "g":
        this.beginPendingCommand({ type: "normal-g" });
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} g`;
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
      case "r":
        this.beginPendingCommand({ type: "replace-char" });
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} r`;
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
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} z`;
        return;
      case "n":
        await this.repeatSearch(editor, 1, this.consumeCount());
        return;
      case "N":
        await this.repeatSearch(editor, -1, this.consumeCount());
        return;
      case "m":
      case "'":
        this.beginPendingCommand(key);
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${key}`;
        return;
      case "f":
      case "F":
      case "t":
      case "T":
        this.beginPendingCommand({ type: "find", motion: key });
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${key}`;
        return;
      case ";":
        await this.repeatFind(editor, false, this.consumeCount());
        return;
      case ",":
        await this.repeatFind(editor, true, this.consumeCount());
        return;
      case "\"":
        this.pendingRegister = true;
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} "`;
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
        await this.enterVisualBlock(editor);
        this.refresh(editor);
        return;
      case "q":
        if (this.recordingMacroRegister) {
          this.stopMacroRecording();
          this.refresh(editor);
          return;
        }
        this.beginPendingCommand({ type: "record-macro" });
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} q`;
        return;
      case "@":
        this.beginPendingCommand({ type: "play-macro" });
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} @`;
        return;
      case "d":
      case "c":
      case "y":
        this.beginPendingCommand(key);
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${key}`;
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
      case "0":
      case "^":
      case "$":
      case "%":
      case "H":
      case "M":
      case "L":
        this.move(editor, key, true, this.consumeCount());
        if (this.mode === "visual-line") {
          this.expandVisualLineSelection(editor);
        } else if (this.mode === "visual-block") {
          this.expandVisualBlockSelections(editor);
        }
        this.refresh(editor);
        return;
      case "g":
        this.pendingOperator = { type: "visual-g" };
        this.statusBar.text = `MVI ${this.mode.toUpperCase()} g`;
        return;
      case "y":
        await this.yankSelection(editor);
        await this.setMode("normal");
        this.collapseToSelectionStart(editor);
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
        await this.setMode("normal");
        this.collapseToSelectionStart(editor);
        return;
      case "V":
        if (this.mode === "visual-line") {
          await this.setMode("normal");
          this.collapseToSelectionStart(editor);
        } else {
          this.visualAnchor = new vscode.Position(editor.selection.active.line, 0);
          await this.setMode("visual-line");
          this.expandVisualLineSelection(editor);
          this.refresh(editor);
        }
        return;
      case "Q":
        if (this.mode === "visual-block") {
          await this.setMode("normal");
          this.collapseToSelectionStart(editor);
        } else {
          await this.enterVisualBlock(editor);
          this.refresh(editor);
        }
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
      }
      this.refresh(editor);
      return;
    }
    if ((operator === "d" || operator === "c" || operator === "y") && ["f", "F", "t", "T"].includes(key)) {
      this.pendingOperator = { type: "operator-find", operator, motion: key };
      this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${operator}${key}`;
      return;
    }
    if (operator && typeof operator === "object" && operator.type === "operator-find") {
      await this.applyOperatorToFind(editor, operator.operator, operator.motion, key);
      this.refresh(editor);
      return;
    }
    if ((operator === "d" || operator === "c" || operator === "y") && (key === "i" || key === "a")) {
      this.pendingOperator = { type: "text-object", operator, kind: key };
      this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${operator}${key}`;
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
      this.jumpToMark(editor, key);
      this.refresh(editor);
      return;
    }
    if (key === "g") {
      this.pendingOperator = { type: "g-prefix", operator };
      this.statusBar.text = `MVI ${this.mode.toUpperCase()} ${operator}g`;
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
    if (["h", "j", "k", "l", "w", "b", "e", "W", "B", "E", "(", ")", "{", "}", "0", "^", "$", "%", "H", "M", "L", "f", "F", "t", "T"].includes(key)) {
      const count = this.resolvePendingCount();
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
    return this.mode === "normal"
      ? this.normalizeNormalPosition(editor.document, editor.selection.active)
      : this.clampPosition(editor.document, editor.selection.active);
  }

  move(editor, key, selecting = false, count = 1) {
    const document = editor.document;
    let next = this.currentPosition(editor);
    for (let i = 0; i < Math.max(1, count); i += 1) {
      switch (key) {
        case "h":
          next = next.translate(0, -1);
          break;
        case "l":
          next = next.translate(0, 1);
          break;
        case "j":
          next = new vscode.Position(Math.min(next.line + 1, document.lineCount - 1), next.character);
          break;
        case "k":
          next = new vscode.Position(Math.max(next.line - 1, 0), next.character);
          break;
        case "0":
          next = new vscode.Position(next.line, 0);
          break;
        case "^":
          next = new vscode.Position(next.line, this.firstNonWhitespace(document.lineAt(next.line).text));
          break;
        case "$":
          next = new vscode.Position(next.line, document.lineAt(next.line).text.length);
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
      : this.clampPosition(document, next);
    if (selecting && this.visualAnchor) {
      if (this.mode === "visual-block") {
        editor.selection = new vscode.Selection(this.visualAnchor, next);
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
    const anchor = this.visualAnchor;
    const active = editor.selection.active;
    const startLine = Math.min(anchor.line, active.line);
    const endLine = Math.max(anchor.line, active.line);
    const startCol = Math.min(anchor.character, active.character);
    const endCol = Math.max(anchor.character, active.character);
    const selections = [];
    for (let line = startLine; line <= endLine; line += 1) {
      const text = editor.document.lineAt(line).text;
      const lineStart = Math.min(startCol, text.length);
      const lineEnd = Math.min(endCol + 1, text.length);
      selections.push(new vscode.Selection(new vscode.Position(line, lineStart), new vscode.Position(line, lineEnd)));
    }
    editor.selections = selections.length ? selections : [new vscode.Selection(anchor, active)];
  }

  async enterVisualBlock(editor) {
    this.visualAnchor = editor.selection.active;
    await this.setMode("visual-block");
    this.expandVisualBlockSelections(editor);
  }

  prepareVisualBlockInsert(editor, append) {
    const selections = editor.selections && editor.selections.length ? editor.selections : [editor.selection];
    editor.selections = selections.map((selection) => {
      const position = append ? selection.end : selection.start;
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
    const prompt = direction > 0 ? "/" : "?";
    const value = await vscode.window.showInputBox({
      prompt: `${prompt} Search`,
      value: this.lastSearch ? this.lastSearch.pattern : ""
    });
    if (!value) {
      this.refresh(editor);
      return;
    }
    this.lastSearch = { pattern: value, direction };
    await this.runSearch(editor, value, direction);
  }

  async openExCommand(editor) {
    const value = await vscode.window.showInputBox({
      prompt: ": Command",
      value: ""
    });
    if (typeof value !== "string") {
      this.refresh(editor);
      return;
    }
    await this.executeExCommand(editor, value.trim());
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
    if (!exCommand) {
      if (range) {
        this.jumpToLine(editor, range.end);
      }
      return;
    }
    if (exCommand === "u" || exCommand === "undo") {
      await vscode.commands.executeCommand("undo");
      return;
    }
    if (exCommand === "set spell") {
      await this.setSpellEnabled(editor, true);
      return;
    }
    if (exCommand === "set nospell") {
      await this.setSpellEnabled(editor, false);
      return;
    }
    if (exCommand === "set spell?") {
      vscode.window.setStatusBarMessage(`mvi spell ${this.spellEnabled ? "on" : "off"}`, 2000);
      return;
    }
    if (exCommand === "redo") {
      await vscode.commands.executeCommand("redo");
      return;
    }
    if (exCommand === "e!" || exCommand === "edit!") {
      await vscode.commands.executeCommand("workbench.action.files.revert");
      return;
    }
    if (exCommand === "w") {
      await editor.document.save();
      return;
    }
    if (/^r\s*!/.test(exCommand)) {
      await this.executeReadShellCommand(editor, range || this.currentLineRange(editor), exCommand.replace(/^r\s*!/, "").trim());
      return;
    }
    if (exCommand === "q" || exCommand === "q!") {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      return;
    }
    if (exCommand === "wq" || exCommand === "x") {
      await editor.document.save();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      return;
    }
    if (exCommand === "d" || exCommand === "delete") {
      await this.executeDeleteRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (exCommand === "y" || exCommand === "yank") {
      await this.executeYankRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (exCommand === "j" || exCommand === "join") {
      await this.executeJoinRange(editor, range || this.currentLineRange(editor));
      return;
    }
    if (/^s./.test(exCommand)) {
      await this.executeSubstitute(editor, exCommand, range);
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

  async runShellCommand(shellCommand) {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-lc", shellCommand], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => {
        resolve(null);
      });
      child.on("close", (code) => {
        resolve(code === 0 ? stdout : null);
      });
    });
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
    const match = trimmed.match(/^([.$]|\d+)(?:,([.$]|\d+))?(?:\s*(.*))?$/);
    if (!match) {
      return { range: null, command: trimmed };
    }
    const start = this.parseExAddress(editor, match[1]);
    const end = this.parseExAddress(editor, match[2] || match[1]);
    if (start === null || end === null) {
      return { range: null, command: trimmed };
    }
    return {
      range: { start: Math.min(start, end), end: Math.max(start, end) },
      command: (match[3] || "").trim()
    };
  }

  parseExAddress(editor, token) {
    if (!token) {
      return null;
    }
    if (token === ".") {
      return editor.selection.active.line;
    }
    if (token === "$") {
      return Math.max(0, editor.document.lineCount - 1);
    }
    if (/^\d+$/.test(token)) {
      const line = Number(token) - 1;
      return Math.max(0, Math.min(line, editor.document.lineCount - 1));
    }
    return null;
  }

  currentLineRange(editor) {
    const line = editor.selection.active.line;
    return { start: line, end: line };
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

  async executeSubstitute(editor, command, explicitRange = null) {
    const parsed = this.parseSubstituteCommand(command);
    if (!parsed) {
      return;
    }
    const { pattern, replacement, flags } = parsed;
    let regex;
    try {
      regex = new RegExp(pattern, flags.includes("g") ? "g" : "");
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
      await this.runSearch(editor, this.lastSearch.pattern, this.lastSearch.direction * directionFactor);
    }
  }

  async runSearch(editor, pattern, direction) {
    const document = editor.document;
    const fullText = document.getText();
    if (!fullText) {
      return;
    }
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "g");
    const currentOffset = document.offsetAt(editor.selection.active);
    let match = null;
    if (direction > 0) {
      regex.lastIndex = Math.min(fullText.length, currentOffset + 1);
      match = regex.exec(fullText);
      if (!match) {
        regex.lastIndex = 0;
        match = regex.exec(fullText);
      }
    } else {
      let currentMatch;
      while ((currentMatch = regex.exec(fullText))) {
        if (currentMatch.index >= currentOffset) {
          break;
        }
        match = currentMatch;
        if (currentMatch[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
      if (!match) {
        while ((currentMatch = regex.exec(fullText))) {
          match = currentMatch;
          if (currentMatch[0].length === 0) {
            regex.lastIndex += 1;
          }
        }
      }
    }
    if (!match) {
      return;
    }
    const position = this.normalizeNormalPosition(document, document.positionAt(match.index));
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

  jumpToMark(editor, name) {
    const target = this.marks.get(name);
    if (!target) {
      return;
    }
    const position = this.normalizeNormalPosition(editor.document, this.clampPosition(editor.document, target));
    editor.selection = new vscode.Selection(position, position);
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
      default:
        break;
    }
    this.refresh(editor);
  }

  startMacroRecording(name) {
    if (!/^[A-Za-z0-9"]$/.test(name)) {
      return;
    }
    this.recordingMacroRegister = /^[A-Z]$/.test(name) ? name.toLowerCase() : name;
    this.registers.set(this.recordingMacroRegister, { events: [] });
    this.statusBar.text = `MVI RECORDING @${this.recordingMacroRegister}`;
  }

  stopMacroRecording() {
    this.recordingMacroRegister = null;
    this.statusBar.text = `MVI ${this.mode.toUpperCase()}`;
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

  collapseToSelectionStart(editor) {
    const start = this.normalizeNormalPosition(editor.document, editor.selection.start);
    editor.selection = new vscode.Selection(start, start);
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

  matchPair(document, position) {
    const pairs = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
    const openers = new Set(["(", "[", "{", "<"]);
    const lineText = document.lineAt(position.line).text;
    const char = lineText[position.character];
    const counterpart = pairs[char];
    if (!counterpart) {
      return position;
    }
    const direction = openers.has(char) ? 1 : -1;
    let depth = 0;
    for (let i = position.character; direction > 0 ? i < lineText.length : i >= 0; i += direction) {
      const current = lineText[i];
      if (current === char) {
        depth += 1;
      } else if (current === counterpart) {
        depth -= 1;
        if (depth === 0) {
          return new vscode.Position(position.line, i);
        }
      }
    }
    return position;
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
    this.normalCursorDecoration.dispose();
    this.normalEmptyCursorDecoration.dispose();
    this.visualLineDecoration.dispose();
    this.visualLineEmptyDecoration.dispose();
    this.cursorLineDecoration.dispose();
  }
}

let controller = null;

async function activate(context) {
  controller = new NativeMviController(context);

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.openEditor", async () => {
    await controller.enable();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.disableNativeEditor", async () => {
    await controller.disable();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.escape", async () => {
    await controller.handleEscape();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.backspace", async () => {
    await controller.handleBackspace();
  }));

  context.subscriptions.push(vscode.commands.registerCommand("mvijs.visualBlock", async () => {
    await controller.handleVisualBlockCommand();
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
    controller.refresh(editor || undefined);
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
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
}

function deactivate() {
  if (controller) {
    controller.dispose();
    controller = null;
  }
}

module.exports = { activate, deactivate };
