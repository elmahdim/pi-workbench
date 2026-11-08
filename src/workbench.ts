import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, CURSOR_MARKER, Input, matchesKey, renderFakeCursor, sliceByColumn, truncateToWidth, visibleWidth,
  type Focusable, type KeybindingsManager, type KeyId, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { graphemes, TextBuffer } from "./buffer.ts";
import { acceptCompletion, languageId, TypeScriptCompletion, type CompletionItem, type CompletionProvider } from "./completion.ts";
import { diffHunks, hunkAtLine } from "./git-diff.ts";
import { fuzzy, Project, type Change, type Document, type MutationQueue, type SearchHit } from "./project.ts";

// Never allow source text or filenames to emit terminal control sequences.
export const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, c => c === "\t" ? "    " : "�");
const pad = (s: string, width: number) => {
  const clipped = truncateToWidth(s, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
type Mode = "files" | "search" | "changes" | "buffers";
interface Row { label: string; path: string; directory?: boolean; line?: number; change?: Change }
interface Prompt { label: string; input: Input; accept: (text: string) => void }
interface Action { label: string; hint: string; keys: KeyId[]; run: () => void }
interface Picker { kind: "commands" | "files"; input: Input; selected: number; top: number }
interface PickerItem { label: string; hint: string; run: () => void }
interface CompletionSnapshot { path: string; text: string; line: number; col: number }
interface Suggestions { items: CompletionItem[]; selected: number; top: number; snapshot: CompletionSnapshot }
const primary = (key: string): KeyId[] => [`super+${key}` as KeyId, `ctrl+${key}` as KeyId];
export interface WorkspaceState { documents: Document[]; active?: string; expanded: Set<string>; sidebarHidden?: boolean }
export interface WorkbenchResult { draft?: string }

export class Workbench implements Focusable {
  focused = true;
  capturesViewportInput = true;
  private mode: Mode = "files";
  private pane: "list" | "content" = "list";
  private paths: string[] = [];
  private changes: Change[] = [];
  private hits: SearchHit[] = [];
  private rows: Row[] = [];
  private selected = 0;
  private listTop = 0;
  private width = 80;
  private height = 20;
  private sidebar = 25;
  private tabBounds: { path: string; x: number; width: number }[] = [];
  private prompt?: Prompt;
  private picker?: Picker;
  private pickerBounds?: { x: number; y: number; width: number; rows: number };
  private diff?: string[];
  private diffTop = 0;
  private diffPath?: string;
  private diffChange?: Change;
  private status = "Loading…";
  private busy = false;
  private disposed = false;
  private controller = new AbortController();
  private highlight?: { text: string; path: string; lines: string[] };
  private paste?: string;
  private cursorVisible = true;
  private cursorTimer?: ReturnType<typeof setInterval>;
  private clipboard = "";
  private language?: CompletionProvider;
  private autoCompletion = true;
  private completion?: Suggestions;
  private completionBounds?: { x: number; y: number; width: number; rows: number };
  private completionTimer?: ReturnType<typeof setTimeout>;
  private completionTicket = 0;
  private createCompletion: () => CompletionProvider;
  private tui: TUI;
  private theme: Theme;
  private kb: KeybindingsManager;
  private project: Project;
  private state: WorkspaceState;
  private queue: MutationQueue;
  private copy: (text: string) => void;
  private done: (result: WorkbenchResult) => void;
  constructor(tui: TUI, theme: Theme, kb: KeybindingsManager,
    project: Project, state: WorkspaceState, queue: MutationQueue,
    copy: (text: string) => void, done: (result: WorkbenchResult) => void,
    createCompletion: () => CompletionProvider = () => new TypeScriptCompletion(project.root)) {
    this.tui = tui; this.theme = theme; this.kb = kb; this.project = project;
    this.state = state; this.queue = queue; this.copy = copy; this.done = done; this.createCompletion = createCompletion;
    if (state.sidebarHidden) this.pane = "content";
    this.resetCursorBlink();
    void this.refresh();
  }
  private resetCursorBlink() {
    clearInterval(this.cursorTimer);
    this.cursorVisible = true;
    this.cursorTimer = setInterval(() => {
      if (!this.focused || this.pane !== "content" || this.diff || this.prompt || this.picker || !this.doc) return;
      this.cursorVisible = !this.cursorVisible; this.redraw();
    }, 500);
    this.cursorTimer.unref();
  }
  private get doc() { return this.state.documents.find(d => d.path === this.state.active); }
  invalidate() { this.highlight = undefined; }
  dispose() { this.disposed = true; clearInterval(this.cursorTimer); this.controller.abort(); this.clearCompletions(); this.language?.stop(); }
  private redraw() { if (!this.disposed) this.tui.requestRender(); }
  private message(text: string) { this.status = text; this.redraw(); }
  private async task(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.redraw();
    try { await action(); } catch (e) { this.status = e instanceof Error ? e.message : String(e); }
    finally { this.busy = false; this.redraw(); }
  }
  private async refresh() {
    await this.task(async () => {
      this.paths = await this.project.files(this.controller.signal);
      try { this.changes = await this.project.changes(); this.status = `${this.paths.length} files`; }
      catch { this.changes = []; this.status = `${this.paths.length} files · Git unavailable or not a repository`; }
      const doc = this.doc;
      if (doc && !this.diff) {
        try {
          const fresh = await this.project.open(doc.path);
          if (!doc.buffer.dirty) {
            const { line, col } = doc.buffer.cursor;
            doc.buffer = fresh.buffer; doc.buffer.move(line, col);
          } else if (fresh.buffer.text !== doc.buffer.saved) this.status = `${doc.path} changed on disk; unsaved buffer kept, save will be blocked`;
        } catch (e) { this.status = `${doc.path}: ${e instanceof Error ? e.message : String(e)}`; }
      }
      if (this.diff && this.diffChange) this.diff = (await this.project.diff(this.diffChange)).split("\n");
      this.rebuild();
    });
  }
  private rebuild() {
    if (this.mode === "changes") this.rows = this.changes.map(c => ({ path: c.path, change: c,
      label: `${c.untracked ? "new" : c.staged ? "idx" : "wrk"} ${c.status} ${c.path}` }));
    else if (this.mode === "buffers") this.rows = this.state.documents.map(d => ({ path: d.path, label: `${d.buffer.dirty ? "●" : " "} ${d.path}` }));
    else if (this.mode === "search") this.rows = this.hits.map(h => ({ path: h.path, line: h.line, label: `${h.path}:${h.line} ${h.text}` }));
    else {
      const seen = new Set<string>(); this.rows = [];
      for (const path of this.paths) {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
          const key = parts.slice(0, i + 1).join("/"); const directory = i < parts.length - 1;
          if (!seen.has(key)) {
            seen.add(key);
            const changed = this.changes.some(c => c.path === key || (directory && c.path.startsWith(`${key}/`)));
            this.rows.push({ path: key, directory, label: `${"  ".repeat(i)}${directory ? this.state.expanded.has(key) ? "▾ " : "▸ " : "  "}${parts[i]}${changed ? " *" : ""}` });
          }
          if (directory && !this.state.expanded.has(key)) break;
        }
      }
    }
    this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
  }
  private switchMode(mode: Mode) {
    this.mode = mode; this.state.sidebarHidden = false; this.selected = this.listTop = 0; this.pane = "list"; this.rebuild(); this.redraw();
    if (mode === "search") this.ask("Search project (literal)", "", query => {
      void this.task(async () => {
        const result = await this.project.search(query, this.controller.signal); this.hits = result.hits;
        this.status = `${result.hits.length}${result.limited ? "+ (limited)" : ""} results for ${query}`; this.rebuild();
      });
    });
  }
  /** The palette and direct shortcuts share one registry, so no action needs a function key. */
  private actions(): Action[] {
    const editor = (key: string) => () => {
      if (this.diff || !this.doc) { this.message("Open an editable file first"); return; }
      this.pane = "content"; this.edit(key);
    };
    return [
      { label: "Quick Open: Find File", hint: "Cmd/Ctrl+P", keys: primary("p"), run: () => this.showPicker("files") },
      { label: "View: Toggle Sidebar", hint: "Cmd/Ctrl+B", keys: primary("b"), run: () => {
        this.state.sidebarHidden = !this.state.sidebarHidden;
        this.pane = this.state.sidebarHidden ? "content" : "list"; this.ensureCursor();
      } },
      { label: "View: Explorer", hint: "Cmd/Ctrl+Shift+E", keys: primary("shift+e"), run: () => this.switchMode("files") },
      // Pi intercepts Ctrl+Shift+F even over overlays; use Ctrl+Alt+F as the terminal fallback.
      { label: "Search: Find in Project", hint: "Cmd+Shift+F / Ctrl+Alt+F", keys: ["super+shift+f", "ctrl+alt+f"], run: () => this.switchMode("search") },
      { label: "Git: Review Current Changes", hint: "Cmd/Ctrl+Shift+G", keys: primary("shift+g"), run: () => this.switchMode("changes") },
      { label: "View: Open Editors", hint: "Cmd/Ctrl+E", keys: primary("e"), run: () => this.switchMode("buffers") },
      { label: "View: Focus Editor", hint: "Cmd/Ctrl+1", keys: primary("1"), run: () => this.backToEditor() },
      { label: "View: Focus Sidebar", hint: "Cmd/Ctrl+0", keys: primary("0"), run: () => { this.state.sidebarHidden = false; this.pane = "list"; } },
      { label: "View: Switch Pane Focus", hint: "Ctrl+L", keys: ["ctrl+l"], run: () => {
        this.pane = this.pane === "list" ? "content" : "list";
        if (this.pane === "list") this.state.sidebarHidden = false; this.ensureCursor();
      } },
      { label: "Workspace: Refresh Files and Changes", hint: "Cmd/Ctrl+R", keys: primary("r"), run: () => { void this.refresh(); } },
      { label: "Git: Back to Editor", hint: "Alt+Left / Esc", keys: ["alt+left"], run: () => this.backToEditor() },
      { label: "Git: Revert File Changes", hint: "confirmation required", keys: [], run: () => this.revertChanges(false) },
      { label: "Git: Revert Current Hunk", hint: "confirmation required", keys: [], run: () => this.revertChanges(true) },
      { label: "Git: Open Editable File from Diff", hint: "Alt+E", keys: ["alt+e"], run: () => {
        if (this.diff && this.diffPath) {
          const patch = this.diff.join("\n"), hunk = diffHunks(patch)[hunkAtLine(patch, this.diffTop)];
          const line = hunk ? Number(hunk.header.match(/\+(\d+)/)?.[1]) || 1 : undefined;
          void this.task(async () => { await this.open(this.diffPath!, line); this.pane = "content"; });
        }
        else this.message("Select a Git diff first");
      } },
      { label: "File: Save", hint: "Cmd/Ctrl+S", keys: primary("s"), run: () => this.save() },
      { label: "File: Close Editor", hint: "Cmd/Ctrl+W", keys: primary("w"), run: () => this.closeEditor() },
      { label: "View: Next Editor", hint: "Ctrl+Tab / Alt+]", keys: ["ctrl+tab", "alt+]"], run: () => this.cycleEditor(1) },
      { label: "View: Previous Editor", hint: "Ctrl+Shift+Tab / Alt+[", keys: ["ctrl+shift+tab", "alt+["], run: () => this.cycleEditor(-1) },
      ...Array.from({ length: 5 }, (_, index): Action => ({
        label: `View: Focus Tab ${index + 1}`, hint: `Alt+${index + 1}`, keys: [`alt+${index + 1}` as KeyId],
        run: () => { const doc = this.state.documents[index]; if (doc) this.focusTab(doc.path); },
      })),
      { label: "Code: Trigger TypeScript/JavaScript Completion", hint: "Ctrl+Space", keys: ["ctrl+space"], run: () => { void this.requestCompletion(); } },
      { label: "Code: Disable IntelliSense", hint: "", keys: [], run: () => {
        this.autoCompletion = false;
        this.clearCompletions(); this.language?.stop(); this.language = undefined; this.message("IntelliSense disabled");
      } },
      { label: "Search: Find in File", hint: "Cmd/Ctrl+F", keys: primary("f"), run: editor("\x06") },
      { label: "Go: Jump to Line", hint: "Cmd/Ctrl+G", keys: primary("g"), run: () => {
        const doc = this.doc; if (!doc || this.diff) { this.message("Open an editable file first"); return; }
        this.ask("Go to line[:column]", "", value => {
          if (!/^\d+(?::\d+)?$/.test(value)) { this.message("Enter a positive line number, optionally :column"); return; }
          const [line, col = 1] = value.split(":").map(Number);
          if (line < 1 || col < 1) { this.message("Line and column must be positive"); return; }
          doc.buffer.move(line - 1, col - 1); this.pane = "content"; this.ensureCursor();
        });
      } },
      { label: "Search: Replace All in File", hint: "Ctrl+H", keys: ["ctrl+h"], run: editor("\x08") },
      { label: "Edit: Undo", hint: "Cmd/Ctrl+Z", keys: primary("z"), run: editor("\x1a") },
      { label: "Edit: Redo", hint: "Cmd/Ctrl+Shift+Z / Ctrl+Y", keys: [...primary("shift+z"), "ctrl+y"], run: editor("\x19") },
      { label: "Edit: Select All", hint: "Cmd/Ctrl+A", keys: primary("a"), run: editor("\x01") },
      { label: "Edit: Copy Selection", hint: "Cmd/Ctrl+C", keys: primary("c"), run: editor("\x03") },
      { label: "Edit: Cut Selection", hint: "Cmd/Ctrl+X", keys: primary("x"), run: editor("\x18") },
      { label: "Edit: Paste Internal Clipboard", hint: "Ctrl+V", keys: ["ctrl+v"], run: editor("\x16") },
      { label: "Pi: Send Selection, Reference or Diff to Draft", hint: "Cmd/Ctrl+Enter", keys: primary("enter"), run: () => this.send() },
      { label: "Workspace: Return to Pi", hint: "Cmd/Ctrl+Q", keys: primary("q"), run: () => this.close() },
    ];
  }
  private clearCompletions() {
    clearTimeout(this.completionTimer); this.completionTimer = undefined;
    this.completion = undefined; this.completionBounds = undefined; this.completionTicket++;
  }
  private completionIsCurrent(snapshot: CompletionSnapshot) {
    const doc = this.doc;
    return !this.disposed && !this.diff && !this.picker && !this.prompt && doc?.path === snapshot.path && doc.buffer.text === snapshot.text &&
      doc.buffer.cursor.line === snapshot.line && doc.buffer.cursor.col === snapshot.col;
  }
  private async requestCompletion(automatic = false) {
    const doc = this.doc;
    if (!doc || this.diff || !languageId(doc.target)) { this.message("Completion supports editable TypeScript/JavaScript files"); return; }
    if (!automatic) this.autoCompletion = true;
    this.clearCompletions(); this.pane = "content";
    const snapshot: CompletionSnapshot = { path: doc.path, text: doc.buffer.text, ...doc.buffer.cursor };
    const frozen = { ...doc, buffer: new TextBuffer(snapshot.text) }; frozen.buffer.move(snapshot.line, snapshot.col);
    const ticket = this.completionTicket;
    const provider = this.language ??= this.createCompletion();
    this.message("Requesting completion…");
    try {
      const items = await provider.complete(frozen);
      if (ticket !== this.completionTicket || !this.completionIsCurrent(snapshot)) return;
      if (items.length) this.completion = { items, selected: 0, top: 0, snapshot };
      this.message(items.length ? `${items.length} completions · ↑↓ choose · Tab accept · Esc dismiss` : "No completions here");
    } catch (error) {
      if (ticket !== this.completionTicket || this.disposed) return;
      provider.stop(); if (this.language === provider) this.language = undefined;
      this.autoCompletion = false; // Avoid retrying a missing/broken server on every keystroke; Ctrl+Space retries.
      this.message(error instanceof Error ? error.message : String(error));
    }
  }
  private scheduleCompletion() {
    this.clearCompletions();
    const doc = this.doc;
    if (!this.autoCompletion || !doc || !languageId(doc.target)) return;
    const prefix = doc.buffer.lines[doc.buffer.cursor.line].slice(0, doc.buffer.cursor.col);
    if (!/\.$|[$_\p{ID_Continue}]{2}$/u.test(prefix)) return;
    const snapshot: CompletionSnapshot = { path: doc.path, text: doc.buffer.text, ...doc.buffer.cursor };
    this.completionTimer = setTimeout(() => {
      if (this.pane === "content" && this.completionIsCurrent(snapshot)) void this.requestCompletion(true);
    }, 150);
  }
  private async chooseCompletion() {
    const suggestions = this.completion, provider = this.language;
    if (!suggestions || !provider) return;
    const item = suggestions.items[suggestions.selected], ticket = this.completionTicket;
    try {
      const resolved = await provider.resolve(item);
      if (ticket !== this.completionTicket || !this.completionIsCurrent(suggestions.snapshot)) return;
      acceptCompletion(this.doc!.buffer, { ...item, ...resolved });
      this.clearCompletions(); this.ensureCursor(); this.message(`Completed ${item.label}`);
    } catch (error) { if (ticket === this.completionTicket) { this.clearCompletions(); this.message(error instanceof Error ? error.message : String(error)); } }
  }
  private showPicker(kind: Picker["kind"]) {
    this.clearCompletions();
    this.picker = { kind, input: new Input({ placeholder: kind === "commands" ? "Search commands…" : "Search files…" }), selected: 0, top: 0 };
    this.redraw();
  }
  private pickerItems(): PickerItem[] {
    const picker = this.picker; if (!picker) return [];
    const query = picker.input.getValue();
    if (picker.kind === "files") return fuzzy(this.paths, query).slice(0, 500).map(path => ({ label: path, hint: "",
      run: () => { void this.task(async () => { await this.open(path); this.pane = "content"; }); } }));
    const actions = this.actions();
    const labels = query ? fuzzy(actions.map(a => a.label), query) : actions.map(a => a.label);
    return labels.map(label => actions.find(a => a.label === label)!);
  }
  private acceptPicker() {
    const item = this.pickerItems()[this.picker?.selected ?? 0];
    if (item) { this.picker = undefined; this.pickerBounds = undefined; item.run(); }
    this.redraw();
  }
  private focusTab(path: string) {
    if (!this.state.documents.some(doc => doc.path === path)) return;
    this.clearCompletions(); this.state.active = path;
    this.diff = undefined; this.diffChange = undefined; this.diffPath = undefined;
    this.pane = "content"; this.resetCursorBlink(); this.ensureCursor(); this.redraw();
  }
  private cycleEditor(direction: number) {
    const docs = this.state.documents; if (!docs.length) return;
    const index = docs.findIndex(d => d.path === this.state.active);
    this.focusTab(docs[(index + direction + docs.length) % docs.length].path);
  }
  private backToEditor() {
    this.diff = undefined; this.diffChange = undefined; this.diffPath = undefined;
    if (this.mode === "changes") {
      this.mode = "files"; this.selected = this.listTop = 0;
      const parts = this.doc?.path.split("/") ?? [];
      for (let i = 1; i < parts.length; i++) this.state.expanded.add(parts.slice(0, i).join("/"));
      this.rebuild();
      this.selected = Math.max(0, this.rows.findIndex(row => row.path === this.doc?.path));
    }
    this.pane = "content"; this.resetCursorBlink(); this.ensureCursor(); this.redraw();
  }
  private revertChanges(singleHunk: boolean) {
    if (!this.diff || !this.diffChange) { this.message("Open and review a Git diff first"); return; }
    const change = { ...this.diffChange }, expected = this.diff.join("\n");
    const hunk = singleHunk ? hunkAtLine(expected, this.diffTop) : undefined;
    if (hunk === -1) { this.message("No textual hunk selected; use Revert File Changes"); return; }
    if (this.state.documents.some(d => d.path === change.path && d.buffer.dirty)) {
      this.message("Revert blocked: this file has unsaved editor changes. Save or close/discard them first"); return;
    }
    void this.task(async () => {
      const plan = await this.project.prepareRevert(change, expected, hunk);
      const hasDirtyAlias = () => this.state.documents.some(d => d.target === plan.target && d.buffer.dirty);
      if (hasDirtyAlias()) throw new Error("Revert blocked: an editor for this file has unsaved changes");
      const verb = change.untracked ? "delete" : "revert";
      const scope = change.untracked ? "DELETE untracked file permanently" : `${singleHunk ? `Revert hunk ${hunk! + 1}` : "Revert ALL file changes"} (${change.staged ? "index + disk → HEAD" : "disk → index; staged changes kept"})`;
      this.ask(`Type ${verb} to confirm; Esc cancels · ${scope}: ${safe(change.path)}`, "", answer => {
        if (answer !== verb) { this.message("Revert cancelled"); return; }
        void this.task(async () => {
          if (hasDirtyAlias()) throw new Error("Revert blocked: unsaved editor changes");
          await this.project.revert(plan, this.queue);
          for (const doc of [...this.state.documents]) {
            if (doc.target !== plan.target) continue;
            try {
              const fresh = await this.project.open(doc.path), cursor = doc.buffer.cursor;
              doc.buffer = fresh.buffer; doc.buffer.move(cursor.line, cursor.col);
            } catch {
              // A reverted addition/deleted untracked file no longer has an editable buffer.
              this.state.documents.splice(this.state.documents.indexOf(doc), 1);
            }
          }
          if (!this.doc) this.state.active = this.state.documents.at(-1)?.path;
          this.changes = await this.project.changes(); this.paths = await this.project.files(this.controller.signal);
          const remaining = this.changes.find(c => c.path === change.path && c.staged === change.staged && c.untracked === change.untracked);
          if (remaining) { this.diffChange = remaining; this.diff = (await this.project.diff(remaining)).split("\n"); this.diffTop = 0; }
          else this.backToEditor();
          this.rebuild(); this.ensureCursor();
          this.status = `${change.untracked ? "Deleted" : "Reverted"} ${singleHunk ? "hunk in " : ""}${change.path}`;
        });
      });
    });
  }
  private closeEditor() {
    const doc = this.doc;
    if (this.diff) { this.backToEditor(); return; }
    if (!doc) return;
    const remove = () => {
      const index = this.state.documents.indexOf(doc); this.state.documents.splice(index, 1);
      this.state.active = this.state.documents[Math.min(index, this.state.documents.length - 1)]?.path;
      this.rebuild(); this.ensureCursor(); this.redraw();
    };
    if (!doc.buffer.dirty) { remove(); return; }
    this.ask(`Unsaved ${safe(doc.path)}: type save or discard, Esc to cancel`, "", answer => {
      if (answer === "discard") remove();
      else if (answer === "save") void this.task(async () => { await this.project.save(doc, this.queue); remove(); });
      else this.message("Close cancelled; unsaved editor kept");
    });
  }
  private ask(label: string, value: string, accept: (text: string) => void) {
    const input = new Input(); input.setValue(value); this.prompt = { label, input, accept }; this.redraw();
  }
  private async activate() {
    const row = this.rows[this.selected]; if (!row) return;
    if (row.directory) {
      if (this.state.expanded.has(row.path)) this.state.expanded.delete(row.path); else this.state.expanded.add(row.path);
      this.rebuild(); this.redraw(); return;
    }
    await this.task(async () => {
      if (row.change) {
        this.diff = (await this.project.diff(row.change)).split("\n"); this.diffPath = row.path; this.diffChange = row.change; this.diffTop = 0;
      } else await this.open(row.path, row.line);
      this.pane = "content";
    });
  }
  private async open(path: string, line?: number) {
    let doc = this.state.documents.find(d => d.path === path);
    if (!doc) {
      if (this.state.documents.length >= 5) throw new Error("Five tabs are already open. Close a tab with Cmd/Ctrl+W before opening another file; unsaved edits are kept.");
      doc = await this.project.open(path); this.state.documents.push(doc);
    }
    else if (!doc.buffer.dirty) {
      // Reopening a clean buffer picks up agent/external changes without risking edits.
      const fresh = await this.project.open(path); doc.buffer = fresh.buffer;
    }
    this.state.active = path; this.diff = undefined;
    if (line) doc.buffer.move(line - 1, 0);
    this.ensureCursor(); this.status = path;
  }
  private ensureCursor() {
    const doc = this.doc; if (!doc) return;
    const rows = Math.max(1, this.height - 5), { line, col } = doc.buffer.cursor;
    if (line < doc.top) doc.top = line;
    if (line >= doc.top + rows) doc.top = line - rows + 1;
    const column = visibleWidth(safe(doc.buffer.lines[line].slice(0, col)));
    const space = Math.max(1, this.width - this.sidebar - 9);
    if (column < doc.left) doc.left = column;
    if (column >= doc.left + space) doc.left = column - space + 1;
  }
  private save() { const doc = this.doc; if (doc) void this.task(async () => {
    await this.project.save(doc, this.queue); this.changes = await this.project.changes().catch(() => []);
    this.rebuild(); this.status = `Saved ${doc.path}`;
  }); }
  private close() {
    if (this.busy) { this.message("Wait for the current operation before closing"); return; }
    const dirty = this.state.documents.filter(d => d.buffer.dirty);
    if (!dirty.length) { this.done({}); return; }
    this.ask(`${dirty.length} unsaved file(s). Type keep to retain buffers, discard to drop edits, or Esc`, "", answer => {
      if (answer === "keep") this.done({});
      else if (answer === "discard") {
        this.state.documents = this.state.documents.filter(d => !d.buffer.dirty); this.done({});
      } else this.message("Close cancelled. Unsaved edits kept.");
    });
  }
  private send() {
    let draft: string;
    if (this.diff) draft = `Review the current changes in ${this.diffPath}:\n\n\`\`\`diff\n${this.diff.join("\n")}\n\`\`\``;
    else if (this.doc) {
      const d = this.doc, selected = d.buffer.selection;
      draft = selected ? `Regarding ${d.path} (selected text${d.buffer.dirty ? ", unsaved buffer" : ""}):\n\n\`\`\`\n${selected}\n\`\`\`` : `Regarding ${d.path}:${d.buffer.cursor.line + 1}${d.buffer.dirty ? " (file has unsaved edits in workbench)" : ""}: `;
    } else return;
    if (Buffer.byteLength(draft) > 48000) { this.message("Selection/diff is too large to send. Select a smaller excerpt."); return; }
    this.done({ draft });
  }
  handleInput(data: string) {
    if (this.disposed) return;
    this.resetCursorBlink();
    // Bracketed paste can arrive in multiple input chunks.
    if (this.paste !== undefined || data.includes("\x1b[200~")) {
      this.paste = (this.paste ?? "") + data.replace("\x1b[200~", "");
      const end = this.paste.indexOf("\x1b[201~");
      if (end >= 0) {
        const text = this.paste.slice(0, end); this.paste = undefined;
        if (!this.picker && !this.prompt && this.pane === "list" && !this.busy && text) this.showPicker("files");
        if (this.picker) {
          this.picker.input.handleInput(`\x1b[200~${text}\x1b[201~`); this.picker.selected = this.picker.top = 0;
        } else if (this.prompt) this.prompt.input.handleInput(`\x1b[200~${text}\x1b[201~`);
        else if (this.pane === "content" && !this.diff && this.doc && !this.busy) {
          this.clearCompletions(); this.doc.buffer.replace(text.replace(/\r\n|\r|\n/g, this.doc.buffer.eol)); this.ensureCursor();
        }
      }
      this.redraw(); return;
    }
    if (this.picker) {
      const picker = this.picker, count = this.pickerItems().length;
      if (matchesKey(data, "escape")) { this.picker = undefined; this.pickerBounds = undefined; }
      else if (this.kb.matches(data, "tui.select.confirm")) this.acceptPicker();
      else if (this.kb.matches(data, "tui.select.up")) picker.selected = Math.max(0, picker.selected - 1);
      else if (this.kb.matches(data, "tui.select.down")) picker.selected = Math.min(Math.max(0, count - 1), picker.selected + 1);
      else if (matchesKey(data, "pageUp")) picker.selected = Math.max(0, picker.selected - 8);
      else if (matchesKey(data, "pageDown")) picker.selected = Math.min(Math.max(0, count - 1), picker.selected + 8);
      else { picker.input.handleInput(data); picker.selected = picker.top = 0; }
      this.redraw(); return;
    }
    if (this.prompt) {
      if (matchesKey(data, "escape")) this.prompt = undefined;
      else if (matchesKey(data, "enter")) { const p = this.prompt; this.prompt = undefined; p.accept(p.input.getValue()); }
      else this.prompt.input.handleInput(data);
      this.redraw(); return;
    }
    if (this.busy) { this.message("Working… please wait"); return; }
    if (this.completion) {
      if (matchesKey(data, "up")) { this.completion.selected = Math.max(0, this.completion.selected - 1); this.redraw(); return; }
      if (matchesKey(data, "down")) { this.completion.selected = Math.min(this.completion.items.length - 1, this.completion.selected + 1); this.redraw(); return; }
      if (matchesKey(data, "tab")) { void this.chooseCompletion(); return; }
      if (matchesKey(data, "escape")) { this.clearCompletions(); this.redraw(); return; }
      this.clearCompletions();
    }
    if ([...primary("k"), ...primary("shift+p")].some(key => matchesKey(data, key))) {
      this.showPicker("commands"); return;
    }
    const action = this.actions().find(action => action.keys.some(key => matchesKey(data, key)));
    if (action) { this.clearCompletions(); action.run(); this.redraw(); return; }
    // Escape dismisses transient UI or selection, never the entire workspace.
    if (matchesKey(data, "escape")) {
      this.clearCompletions();
      if (this.diff || this.mode === "changes") { this.backToEditor(); return; }
      if (this.doc) this.doc.buffer.anchor = undefined;
      this.pane = "content"; this.ensureCursor(); this.redraw(); return;
    }
    if (this.pane === "list") {
      if (data && !/[\x00-\x1f\x7f-\x9f]/.test(data)) {
        this.showPicker("files"); this.picker!.input.handleInput(data);
      }
      else if (this.kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
      else if (this.kb.matches(data, "tui.select.down")) this.selected = Math.min(this.rows.length - 1, this.selected + 1);
      else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - this.height + 5);
      else if (matchesKey(data, "pageDown")) this.selected = Math.min(this.rows.length - 1, this.selected + this.height - 5);
      else if (this.kb.matches(data, "tui.select.confirm") || matchesKey(data, "right")) void this.activate();
      else if (matchesKey(data, "left")) {
        const row = this.rows[this.selected]; if (row?.directory) { this.state.expanded.delete(row.path); this.rebuild(); }
      }
    } else if (this.diff) {
      if (matchesKey(data, "up")) this.diffTop = Math.max(0, this.diffTop - 1);
      else if (matchesKey(data, "down")) this.diffTop = Math.min(Math.max(0, this.diff.length - 1), this.diffTop + 1);
      else if (matchesKey(data, "pageUp")) this.diffTop = Math.max(0, this.diffTop - this.height + 5);
      else if (matchesKey(data, "pageDown")) this.diffTop = Math.min(Math.max(0, this.diff.length - 1), this.diffTop + this.height - 5);
      else if (matchesKey(data, "alt+down") || matchesKey(data, "alt+up")) {
        const patch = this.diff.join("\n"), hunks = diffHunks(patch), current = hunkAtLine(patch, this.diffTop);
        const index = Math.max(0, Math.min(hunks.length - 1, current + (matchesKey(data, "alt+down") ? 1 : -1)));
        if (hunks[index]) this.diffTop = hunks[index].start;
      }
    } else this.edit(data);
    this.redraw();
  }
  private edit(data: string) {
    const doc = this.doc; if (!doc) return;
    const b = doc.buffer, { line, col } = b.cursor, before = b.text;
    if (matchesKey(data, "ctrl+f")) this.ask("Find in file (literal)", "", q => { this.message(b.find(q) ? "Match selected" : "No match"); this.ensureCursor(); });
    else if (matchesKey(data, "ctrl+h")) this.ask("Replace: find literal", "", query => {
      if (!query) return;
      this.ask("Replace all with (Enter allows empty replacement)", "", value => {
        const count = b.text.split(query).length - 1;
        if (count) { b.selectAll(); b.replace(b.text.split(query).join(value)); }
        this.message(`Replaced ${count} occurrences`); this.ensureCursor();
      });
    });
    else if (matchesKey(data, "ctrl+a")) b.selectAll();
    else if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+x")) {
      if (b.selection) { this.clipboard = b.selection; this.copy(this.clipboard); if (matchesKey(data, "ctrl+x")) b.replace(""); }
    } else if (matchesKey(data, "ctrl+v")) { if (this.clipboard) b.replace(this.clipboard); else this.message("Use your terminal's paste shortcut to paste system clipboard text"); }
    else if (matchesKey(data, "ctrl+z")) b.undo();
    else if (matchesKey(data, "ctrl+y") || matchesKey(data, "ctrl+shift+z")) b.redo();
    else if (matchesKey(data, "backspace")) b.delete(-1);
    else if (matchesKey(data, "delete")) b.delete(1);
    else if (matchesKey(data, "enter")) b.replace(b.eol + (b.lines[line].match(/^\s*/)?.[0] ?? ""));
    else if (matchesKey(data, "tab")) b.replace("\t");
    else {
      let moved = false;
      for (const select of [false, true]) {
        const prefix = select ? "shift+" : "";
        if (matchesKey(data, `${prefix}left`)) { b.horizontal(-1, select); moved = true; }
        else if (matchesKey(data, `${prefix}right`)) { b.horizontal(1, select); moved = true; }
        else if (matchesKey(data, `${prefix}up`)) { b.move(line - 1, col, select); moved = true; }
        else if (matchesKey(data, `${prefix}down`)) { b.move(line + 1, col, select); moved = true; }
        else if (matchesKey(data, `${prefix}home`) || matchesKey(data, `super+${prefix}left`)) { b.move(line, 0, select); moved = true; }
        else if (matchesKey(data, `${prefix}end`) || matchesKey(data, `super+${prefix}right`)) { b.move(line, b.lines[line].length, select); moved = true; }
        if (moved) break;
      }
      if (!moved) {
        if (matchesKey(data, "pageUp")) b.move(line - this.height + 5, col);
        else if (matchesKey(data, "pageDown")) b.move(line + this.height - 5, col);
        else if (matchesKey(data, "ctrl+home")) b.move(0, 0);
        else if (matchesKey(data, "ctrl+end")) b.move(b.lines.length - 1, b.lines.at(-1)!.length);
        else if (!/[\x00-\x1f\x7f-\x9f]/.test(data)) b.replace(data);
      }
    }
    this.ensureCursor();
    if (b.text !== before) {
      this.clearCompletions();
      if (!/[\x00-\x1f\x7f-\x9f]/.test(data) || matchesKey(data, "backspace")) this.scheduleCompletion();
    }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.picker) {
      const b = this.pickerBounds;
      if (!b) return { handled: true };
      const localX = event.x - b.x, localY = event.y - b.y;
      if (localX < 0 || localX >= b.width || localY < 0 || localY >= b.rows + 5) {
        if (event.type === "click") { this.picker = undefined; this.pickerBounds = undefined; this.redraw(); }
      } else if (event.type === "wheel") {
        this.picker.selected = Math.max(0, Math.min(Math.max(0, this.pickerItems().length - 1), this.picker.selected + (event.wheelDelta ?? 0)));
      } else if (localY === 2) this.picker.input.handleMouse({ ...event, x: localX - 2, y: 0, width: Math.max(1, b.width - 4), height: 1 });
      else if (event.type === "click" && event.button === "left" && localY >= 3 && localY < b.rows + 3) {
        const index = this.picker.top + localY - 3;
        if (index < this.pickerItems().length) { this.picker.selected = index; this.acceptPicker(); }
      }
      this.redraw(); return { handled: true, render: true };
    }
    if (this.prompt || this.busy) return { handled: true };
    if (event.y === 1 && event.type === "click" && event.button === "left") {
      const tab = this.tabBounds.find(tab => event.x >= tab.x && event.x < tab.x + tab.width);
      if (tab) { this.focusTab(tab.path); return { handled: true, render: true }; }
    }
    if (this.completion && this.completionBounds) {
      const b = this.completionBounds;
      if (event.x >= b.x && event.x < b.x + b.width && event.y >= b.y && event.y < b.y + b.rows + 1) {
        if (event.type === "wheel") this.completion.selected = Math.max(0, Math.min(this.completion.items.length - 1, this.completion.selected + (event.wheelDelta ?? 0)));
        else if (event.type === "click" && event.button === "left" && event.y > b.y) {
          this.completion.selected = this.completion.top + event.y - b.y - 1; void this.chooseCompletion();
        }
        this.redraw(); return { handled: true, render: true };
      }
    }
    if (["press", "click", "drag", "wheel"].includes(event.type)) this.clearCompletions();
    const body = event.y - 2;
    if (body < 0 || body >= this.height - 5) return undefined;
    if (event.x < this.sidebar) {
      if (event.type === "wheel") { this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + (event.wheelDelta ?? 0))); }
      else if (event.type === "click" && event.button === "left") {
        this.pane = "list"; this.selected = Math.min(this.rows.length - 1, this.listTop + body); void this.activate();
      }
    } else {
      this.pane = "content";
      if (event.type === "wheel") {
        if (this.diff) this.diffTop = Math.max(0, Math.min(this.diff.length - 1, this.diffTop + (event.wheelDelta ?? 0)));
        else if (this.doc) this.doc.top = Math.max(0, Math.min(this.doc.buffer.lines.length - 1, this.doc.top + (event.wheelDelta ?? 0)));
      } else if (this.diff && event.type === "click" && event.button === "left") {
        const hunks = diffHunks(this.diff.join("\n"));
        const index = hunkAtLine(this.diff.join("\n"), this.diffTop + body);
        if (index >= 0) this.diffTop = hunks[index].start;
      } else if (!this.diff && this.doc && event.button === "left" && ["press", "drag", "click"].includes(event.type)) {
        const d = this.doc, line = Math.min(d.buffer.lines.length - 1, d.top + body);
        const target = Math.max(0, event.x - this.sidebar - (this.sidebar ? 1 : 0) - 7 + d.left);
        let column = 0, col = 0;
        for (const g of graphemes(d.buffer.lines[line])) { const w = visibleWidth(safe(g.segment)); if (column + w > target) break; column += w; col = g.index + g.segment.length; }
        // Click follows press/release; don't clear a selection created by dragging.
        if (event.type !== "click") d.buffer.move(line, col, event.type === "drag" || event.shift);
        this.redraw(); return { handled: true, capture: event.type === "press", render: true };
      }
    }
    this.redraw(); return { handled: true, render: true };
  }
  private codeLine(doc: Document, line: number, width: number): string {
    const b = doc.buffer, value = b.lines[line]; if (value === undefined) return "";
    const [start, end] = b.range, base = b.offset({ line, col: 0 });
    const isCaret = this.focused && this.pane === "content" && !this.prompt && !this.picker && line === b.cursor.line;
    let content: string;
    if (isCaret || (end > base && start <= base + value.length)) {
      // Split only at decoration boundaries, retaining the highlighter's ANSI
      // foreground colors beneath the selection and caret (including while typing).
      const highlighted = this.highlight?.lines[line] ?? safe(value);
      const caretEnd = isCaret ? [...graphemes(value)].find(g => g.index === b.cursor.col) : undefined;
      const boundaries = [...new Set([0, value.length,
        Math.max(0, Math.min(value.length, start - base)), Math.max(0, Math.min(value.length, end - base)),
        ...(isCaret ? [b.cursor.col, b.cursor.col + (caretEnd?.segment.length ?? 0)] : []),
      ])].sort((a, b) => a - b);
      content = "";
      let column = 0;
      for (let i = 0; i < boundaries.length - 1; i++) {
        const from = boundaries[i], to = boundaries[i + 1];
        const nextColumn = column + visibleWidth(safe(value.slice(from, to)));
        let text = sliceByColumn(highlighted, column, nextColumn - column) + "\x1b[0m";
        column = nextColumn;
        if (base + from >= start && base + from < end) text = this.theme.bg("selectedBg", text);
        if (isCaret && from === b.cursor.col) text = CURSOR_MARKER + (this.cursorVisible ? renderFakeCursor(text) : text);
        content += text;
      }
      if (isCaret && b.cursor.col === value.length) content += CURSOR_MARKER + (this.cursorVisible ? renderFakeCursor(" ") : " ");
    } else content = this.highlight?.lines[line] ?? safe(value);
    return this.theme.fg("dim", `${String(line + 1).padStart(5)}  `) + sliceByColumn(content, doc.left, Math.max(0, width - 7));
  }
  private renderPicker(base: string[], width: number): string[] {
    const picker = this.picker!, items = this.pickerItems(), t = this.theme;
    const w = Math.max(1, Math.min(88, width - 4));
    const x = Math.max(0, Math.floor((width - w) / 2));
    const rows = Math.max(1, Math.min(10, base.length - 6));
    const y = base.length > rows + 5 ? 1 : 0;
    picker.selected = Math.min(picker.selected, Math.max(0, items.length - 1));
    if (picker.selected < picker.top) picker.top = picker.selected;
    if (picker.selected >= picker.top + rows) picker.top = picker.selected - rows + 1;
    this.pickerBounds = { x, y, width: w, rows };
    const inside = Math.max(0, w - 2), inputWidth = Math.max(1, w - 4);
    const frame = (line: string) => t.fg("border", "│") + pad(line, inside) + t.fg("border", "│");
    picker.input.focused = this.focused;
    const lines = [
      t.fg("border", `╭${"─".repeat(inside)}╮`),
      frame(t.fg("accent", picker.kind === "commands" ? " Command Palette" : " Quick Open")),
      frame(` ${picker.input.render(inputWidth)[0] ?? ""}`),
    ];
    for (let n = 0; n < rows; n++) {
      const index = picker.top + n, item = items[index];
      let text = "";
      if (item) {
        const hintWidth = Math.min(item.hint.length, Math.floor(Math.max(0, inside - 4) / 2));
        text = ` ${pad(safe(item.label), Math.max(0, inside - hintWidth - 2))} ${hintWidth ? t.fg("dim", pad(item.hint, hintWidth)) : ""}`;
      } else if (n === 0) text = " No results";
      if (item && index === picker.selected) text = t.bg("selectedBg", pad(text, inside));
      lines.push(frame(text));
    }
    lines.push(frame(t.fg("dim", ` ↑↓ select · Enter open · Esc cancel · ${items.length} results`)));
    lines.push(t.fg("border", `╰${"─".repeat(inside)}╯`));
    for (let n = 0; n < lines.length && y + n < base.length; n++) {
      base[y + n] = compositeTuiLine(base[y + n], truncateToWidth(lines[n], w, ""), x, w, width);
    }
    return base.map(line => truncateToWidth(line, width));
  }
  private renderCompletions(base: string[], width: number): string[] {
    const suggestions = this.completion, doc = this.doc;
    if (!suggestions || !doc || this.diff || this.prompt) return base;
    const cursorY = 2 + doc.buffer.cursor.line - doc.top;
    const below = base.length - 3 - cursorY - 1, above = cursorY - 2;
    const room = Math.max(below, above); if (room < 2 || cursorY < 2 || cursorY >= base.length - 3) return base;
    const rows = Math.min(6, suggestions.items.length, room - 1);
    const y = below >= rows + 1 ? cursorY + 1 : cursorY - rows - 1;
    const w = Math.max(1, Math.min(64, width));
    const column = this.sidebar + (this.sidebar ? 1 : 0) + 7 + visibleWidth(safe(doc.buffer.lines[doc.buffer.cursor.line].slice(0, doc.buffer.cursor.col))) - doc.left;
    const x = Math.max(0, Math.min(width - w, column));
    this.completionBounds = { x, y, width: w, rows };
    if (suggestions.selected < suggestions.top) suggestions.top = suggestions.selected;
    if (suggestions.selected >= suggestions.top + rows) suggestions.top = suggestions.selected - rows + 1;
    const lines = [this.theme.fg("accent", pad(" Completions · Tab accept · Esc dismiss", w))];
    for (let n = 0; n < rows; n++) {
      const index = suggestions.top + n, item = suggestions.items[index];
      const line = pad(` ${safe(item.label)}${item.detail ? ` · ${safe(item.detail)}` : ""}`, w);
      lines.push(this.theme.bg("selectedBg", index === suggestions.selected ? this.theme.fg("accent", line) : line));
    }
    for (let n = 0; n < lines.length; n++) base[y + n] = compositeTuiLine(base[y + n], lines[n], x, w, width);
    return base;
  }
  render(width: number): string[] {
    this.width = width; this.height = Math.max(6, this.tui.terminal.rows - 2);
    const oldSidebar = this.sidebar;
    this.sidebar = this.state.sidebarHidden ? 0 : width >= 70 ? Math.min(38, Math.floor(width * .3)) : this.pane === "list" ? width : 0;
    if (oldSidebar !== this.sidebar && this.pane === "content") this.ensureCursor();
    const height = this.height, bodyHeight = height - 5, right = Math.max(0, width - this.sidebar - (this.sidebar ? 1 : 0));
    const t = this.theme;
    const doc = this.doc;
    if (doc && !this.diff && (this.highlight?.text !== doc.buffer.text || this.highlight?.path !== doc.path)) {
      const text = doc.buffer.lines.map(safe).join("\n");
      this.highlight = { text: doc.buffer.text, path: doc.path, lines: text.length <= 200000 ? highlightCode(text, getLanguageFromPath(doc.path)) : text.split("\n") };
    }
    if (this.selected < this.listTop) this.listTop = Math.max(0, this.selected);
    if (this.selected >= this.listTop + bodyHeight) this.listTop = this.selected - bodyHeight + 1;
    const hunks = this.diff ? diffHunks(this.diff.join("\n")) : [];
    const currentHunk = this.diff ? hunkAtLine(this.diff.join("\n"), this.diffTop) : -1;
    const title = this.diff ? `DIFF ${this.diffPath}${hunks.length ? ` · Hunk ${currentHunk + 1}/${hunks.length}` : ""}` : doc ? `${doc.buffer.dirty ? "● " : ""}${doc.path}` : "Open a file to begin";
    // Reuse the header row so tabs do not steal editor lines or shift mouse coordinates.
    this.tabBounds = [];
    let tabs = "", x = this.sidebar + (this.sidebar && right ? 1 : 0);
    const docs = this.state.documents, tabWidth = docs.length ? Math.floor(right / docs.length) : 0;
    for (let index = 0; index < docs.length && tabWidth > 0; index++) {
      const current = docs[index], active = current.path === this.state.active;
      const size = index === docs.length - 1 ? right - tabWidth * index : tabWidth;
      const label = `${active ? "▸" : " "}${index + 1} ${current.buffer.dirty ? "● " : ""}${safe(current.path.split("/").at(-1)!)} `;
      const text = pad(label, size);
      tabs += active ? t.bg("selectedBg", t.fg("accent", text)) : t.fg("muted", text);
      this.tabBounds.push({ path: current.path, x, width: size }); x += size;
    }
    if (!tabs && right) tabs = t.fg("accent", pad(safe(title), right));
    const lines = [t.fg("accent", pad(safe(this.diff ? ` ${title}` : ` pi-workbench · ${this.project.root}`), width)),
      pad(`${this.pane === "list" ? "▸" : " "} ${this.mode}`, this.sidebar) + (this.sidebar && right ? "│" : "") + tabs];
    for (let n = 0; n < bodyHeight; n++) {
      const index = this.listTop + n, row = this.rows[index];
      let left = pad(row ? safe(row.label) : index === 0 ? "(empty)" : "", this.sidebar);
      if (row && index === this.selected) left = t.bg("selectedBg", left);
      let content = "";
      if (right && this.diff) {
        const raw = this.diff[this.diffTop + n] ?? "";
        content = t.fg(raw.startsWith("+") ? "success" : raw.startsWith("-") ? "error" : raw.startsWith("@@") ? "accent" : "text", safe(raw));
        if (currentHunk >= 0 && this.diffTop + n === hunks[currentHunk].start) content = t.bg("selectedBg", content);
      } else if (right && doc) content = this.codeLine(doc, doc.top + n, right);
      lines.push(left + (this.sidebar && right ? t.fg("border", "│") : "") + (right ? pad(content, right) : ""));
    }
    if (this.prompt) {
      this.prompt.input.focused = this.focused;
      lines.push(truncateToWidth(t.fg("accent", this.prompt.label), width));
      lines.push(...this.prompt.input.render(width).slice(0, 1));
    } else {
      const cursor = doc && !this.diff ? ` · Ln ${doc.buffer.cursor.line + 1}, Col ${doc.buffer.cursor.col + 1}` : "";
      const count = new Set(this.changes.map(change => change.path)).size;
      const changes = count ? `${count} ${count === 1 ? "change" : "changes"} · ` : "";
      lines.push(truncateToWidth(t.fg("muted", safe(`${changes}${this.busy ? "Working… " : ""}${this.status}${cursor}`)), width));
      lines.push(truncateToWidth(this.diff ? "Esc / Alt+Left Back to editor  Alt+E Edit this file  Alt+↑↓ Select hunk" : "Cmd/Ctrl+K Commands  Cmd/Ctrl+P Files  Cmd/Ctrl+B Sidebar", width));
    }
    lines.push(truncateToWidth(t.fg("dim", this.diff ? "Cmd/Ctrl+K → Revert File Changes / Revert Current Hunk (confirmation required)" : "Ctrl+L Focus pane  Ctrl+Space Complete  Cmd/Ctrl+S Save  Cmd/Ctrl+Q Back to pi"), width));
    const rendered = lines.map(l => truncateToWidth(l, width));
    return this.picker ? this.renderPicker(rendered, width) : this.renderCompletions(rendered, width);
  }
}
