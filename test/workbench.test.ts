import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, renderFakeCursor, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Project } from "../src/project.ts";
import { TextBuffer } from "../src/buffer.ts";
import type { CompletionItem, CompletionProvider } from "../src/completion.ts";
import { Workbench, safe, type WorkspaceState, type WorkbenchResult } from "../src/workbench.ts";
initTheme("dark", false);
const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text } as Theme;
async function setup(t: { after: (f: () => Promise<void>) => void }, createCompletion?: () => CompletionProvider) {
  const root = await mkdtemp(join(tmpdir(), "workbench-ui-"));
  await writeFile(join(root, "file.ts"), "const 界 = '👨‍👩‍👧‍👦';\n\tsecond\nthird\n");
  const project = new Project(root), doc = await project.open("file.ts");
  const state: WorkspaceState = { documents: [doc], active: doc.path, expanded: new Set() };
  const terminal = { rows: 24 }, tui = { terminal, requestRender() {} } as unknown as TUI;
  const results: WorkbenchResult[] = [];
  const ui = new Workbench(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), project, state,
    async (_path, action) => action(), () => {}, result => results.push(result), createCompletion);
  t.after(async () => { ui.dispose(); await rm(root, { recursive: true, force: true }); });
  // Wait for initialization, which also handles a non-Git directory.
  for (let n = 0; n < 200; n++) { if (!ui.render(100).join("\n").includes("Working…")) break; await new Promise(r => setTimeout(r, 5)); }
  return { ui, state, doc, results, terminal, project };
}
async function settle(ui: Workbench) {
  for (let n = 0; n < 200; n++) {
    if (!ui.render(100).join("\n").includes("Working…")) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("Workbench operation did not settle");
}
test("sanitizes terminal control sequences", () => {
  assert.equal(safe("a\x1b[31m\x07\t"), "a�[31m�    ");
});
test("renders narrow/wide terminals and keeps the IME cursor in the editor pane", async t => {
  const { ui, terminal } = await setup(t);
  ui.handleInput("\x0c"); // Ctrl+L: editor pane
  for (const width of [1, 12, 40, 69, 70, 100, 180]) {
    const lines = ui.render(width);
    assert(lines.every(line => visibleWidth(line) <= width), `overflow at ${width}`);
    assert(lines.length <= terminal.rows);
    if (width >= 40) assert(lines.some(line => line.includes(CURSOR_MARKER)), `missing caret at ${width}`);
  }
  terminal.rows = 10; assert(ui.render(80).length <= 10);
});
test("typing in the sidebar starts file search and preserves the initial query", async t => {
  const { ui, doc } = await setup(t), original = doc.buffer.text;
  ui.handleInput("fl"); ui.handleInput("ts");
  assert.match(ui.render(100).join("\n"), /Quick Open/);
  assert.match(ui.render(100).join("\n"), /flts/);
  assert.equal(doc.buffer.text, original);
  ui.handleInput("\x1b");
  assert(!ui.render(100).join("\n").includes("Quick Open"));
  ui.handleInput("\x1b[200~file\x1b[201~");
  assert.match(ui.render(100).join("\n"), /Quick Open/);
  ui.handleInput("\r"); await settle(ui);
  ui.handleInput("X"); assert.equal(doc.buffer.text, `X${original}`);
});
test("editor caret blinks, retains the IME marker, and resets on typing", async t => {
  const { ui } = await setup(t);
  ui.handleInput("\x0c");
  const caret = () => ui.render(100).join("\n").split(CURSOR_MARKER)[1]?.replace(/\x1b\[[0-9;]*m/g, "");
  assert(caret()?.startsWith(renderFakeCursor("c")));
  await new Promise(r => setTimeout(r, 550));
  assert(caret()?.startsWith("c"));
  ui.handleInput("X"); assert(caret()?.startsWith(renderFakeCursor("c")));
  ui.dispose();
  await new Promise(r => setTimeout(r, 550));
  assert(caret()?.startsWith(renderFakeCursor("c")));
});
test("typing, multiline paste, undo/redo, and close protection", async t => {
  const { ui, doc, results } = await setup(t);
  ui.handleInput("\x0c"); // Ctrl+L
  const original = doc.buffer.text;
  ui.handleInput("X"); assert.equal(doc.buffer.text, `X${original}`);
  ui.handleInput("\x1a"); assert.equal(doc.buffer.text, original); // Ctrl+Z
  ui.handleInput("\x19"); assert.equal(doc.buffer.text, `X${original}`); // Ctrl+Y
  ui.handleInput("\x1b[200~hello\n"); ui.handleInput("world\x1b[201~");
  assert.match(doc.buffer.text, /^Xhello\nworldconst/);
  ui.handleInput("\x1b"); assert.equal(results.length, 0); // Escape no longer exits the workspace.
  ui.handleInput("\x11"); assert.equal(results.length, 0); // Ctrl+Q protects unsaved buffers.
  assert(ui.render(100).join("\n").includes("unsaved"));
  ui.handleInput("keep"); ui.handleInput("\r");
  assert.equal(results.length, 1); assert(doc.buffer.dirty);
});
test("Ctrl+Enter creates a draft without submitting or losing unsaved buffers", async t => {
  const { ui, doc, results } = await setup(t);
  doc.buffer.move(0, 0); doc.buffer.move(0, 5, true);
  ui.handleInput("\x1b[13;5u"); // Ctrl+Enter (Kitty protocol)
  assert.match(results[0].draft!, /file.ts/); assert.match(results[0].draft!, /const/);
});
test("literal search opens a matching line and refresh preserves dirty buffers", async t => {
  const { ui, state, doc } = await setup(t);
  ui.handleInput("\x1b\x06"); // Ctrl+Alt+F
  ui.handleInput("second"); ui.handleInput("\r"); await settle(ui);
  assert.match(ui.render(100).join("\n"), /file.ts:2/);
  ui.handleInput("\r"); await settle(ui);
  assert.equal(state.active, "file.ts"); assert.equal(doc.buffer.cursor.line, 1);
  const original = doc.buffer.text;
  doc.buffer.replace("unsaved");
  await writeFile(doc.target, "externally changed\n");
  ui.handleInput("\x12"); await settle(ui); // Ctrl+R
  assert(doc.buffer.text.includes("unsaved")); assert(doc.buffer.dirty);
  assert.match(ui.render(100).join("\n"), /changed on disk/);
  doc.buffer.undo(); assert.equal(doc.buffer.text, original);
  ui.handleInput("\x12"); await settle(ui);
  assert.equal(doc.buffer.text, "externally changed\n");
});
test("mouse positioning, drag selection and wheel scrolling", async t => {
  const { ui, doc } = await setup(t); ui.render(100);
  const event = (type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent => ({
    type, x, y, screenX: x, screenY: y, button: "left", width: 100, height: 22, shift: false, ctrl: false, alt: false,
  });
  assert(ui.handleMouse(event("press", 38, 2))?.capture); // sidebar 30 + divider 1 + gutter 7
  assert.deepEqual(doc.buffer.cursor, { line: 0, col: 0 });
  ui.handleMouse(event("drag", 43, 2)); assert.equal(doc.buffer.selection, "const");
  ui.handleMouse(event("release", 43, 2)); ui.handleMouse(event("click", 43, 2)); assert.equal(doc.buffer.selection, "const");
  ui.handleMouse({ ...event("wheel", 60, 4), wheelDelta: 1 }); assert.equal(doc.top, 1);
});
test("command palette filters commands and cancels without editing or exiting", async t => {
  const { ui, doc, results } = await setup(t), original = doc.buffer.text;
  ui.handleInput("\x0b"); // Ctrl+K
  let screen = ui.render(100).join("\n");
  assert.match(screen, /Command Palette/); assert.match(screen, /Quick Open/);
  assert.equal(screen.split(CURSOR_MARKER).length - 1, 1);
  ui.handleInput("togside"); screen = ui.render(100).join("\n");
  assert.match(screen, /Toggle Sidebar/);
  ui.handleInput("\x1b");
  assert(!ui.render(100).join("\n").includes("Command Palette"));
  assert.equal(doc.buffer.text, original); assert.equal(results.length, 0);
});
test("palette executes filtered actions and exposes actions without direct shortcuts", async t => {
  const { ui, state } = await setup(t);
  ui.handleInput("\x0b"); ui.handleInput("Toggle Sidebar"); ui.handleInput("\r");
  assert.equal(state.sidebarHidden, true);
  assert(!ui.render(100).join("\n").includes("Command Palette"));
  ui.handleInput("\x0b"); ui.handleInput("Open Editable File");
  assert.match(ui.render(100).join("\n"), /Open Editable File/);
  ui.handleInput("\r"); assert.match(ui.render(100).join("\n"), /Select a Git diff first/);
});
test("quick open filters live and opens on a single Enter without changing sidebar state", async t => {
  const { ui, state, doc } = await setup(t);
  ui.handleInput("\x02"); // Ctrl+B
  ui.handleInput("\x10"); // Ctrl+P
  assert.match(ui.render(100).join("\n"), /Quick Open/);
  ui.handleInput("flts"); assert.match(ui.render(100).join("\n"), /file.ts/);
  ui.handleInput("\r"); await settle(ui);
  assert.equal(state.active, "file.ts"); assert.equal(state.sidebarHidden, true);
  assert(!ui.render(100).join("\n").includes("Quick Open\n"));
  ui.handleInput("X"); assert(doc.buffer.text.startsWith("X"));
});
test("sidebar collapse preserves dirty edits, frees full width, and fixes mouse coordinates", async t => {
  const { ui, state, doc } = await setup(t);
  ui.handleInput("\x02"); // Ctrl+B collapses and focuses editor.
  ui.handleInput("X"); assert(doc.buffer.dirty); assert.equal(state.sidebarHidden, true);
  const hidden = ui.render(100); assert(!hidden[2].includes("│")); assert(hidden[2].includes("    1"));
  const press: TuiMouseEvent = { type: "press", button: "left", x: 7, y: 2, screenX: 7, screenY: 2,
    width: 100, height: 22, shift: false, ctrl: false, alt: false };
  ui.handleMouse(press); assert.deepEqual(doc.buffer.cursor, { line: 0, col: 0 });
  ui.handleInput("\x02"); assert.equal(state.sidebarHidden, false);
  assert(ui.render(100)[2].includes("│")); assert(doc.buffer.text.startsWith("X"));
  ui.handleInput("\x0b"); ui.handleInput("Focus Editor"); ui.handleInput("\r");
  assert(ui.render(100).some(line => line.includes(CURSOR_MARKER)));
});
test("Command key aliases work when the terminal reports the super modifier", async t => {
  const { ui, state } = await setup(t);
  ui.handleInput("\x1b[107;9u"); // Cmd+K
  assert.match(ui.render(100).join("\n"), /Command Palette/);
  ui.handleInput("\x1b"); ui.handleInput("\x1b[98;9u"); // Cmd+B
  assert.equal(state.sidebarHidden, true);
  ui.handleInput("\x1b[112;9u"); // Cmd+P
  assert.match(ui.render(100).join("\n"), /Quick Open/);
});
test("palette handles empty results, scrolling, mouse selection, and tiny terminals", async t => {
  const { ui, state, terminal } = await setup(t);
  ui.handleInput("\x0b"); ui.handleInput("not-a-command-xyz"); ui.handleInput("\r");
  assert.match(ui.render(100).join("\n"), /No results/);
  ui.handleInput("\x1b"); ui.handleInput("\x0b"); ui.handleInput("Toggle Sidebar");
  ui.render(100); // Palette at x=6, y=1; input y=3, first result y=4.
  ui.handleMouse({ type: "click", button: "left", x: 10, y: 4, screenX: 10, screenY: 4,
    width: 100, height: 22, shift: false, ctrl: false, alt: false });
  assert.equal(state.sidebarHidden, true);
  ui.handleInput("\x0b");
  for (let i = 0; i < 100 && !ui.render(100).join("\n").includes("Edit: Undo"); i++) ui.handleInput("\x1b[B");
  assert(ui.render(100).join("\n").includes("Edit: Undo"));
  for (const rows of [8, 24]) for (const width of [1, 12, 40, 80, 120]) {
    terminal.rows = rows;
    const lines = ui.render(width);
    assert(lines.length <= rows); assert(lines.every(line => visibleWidth(line) <= width));
  }
});
test("closing editors protects dirty buffers and cycling never loses edits", async t => {
  const { ui, state, doc } = await setup(t);
  const second = { ...doc, path: "other.ts", buffer: new TextBuffer("other") };
  state.documents.push(second);
  doc.buffer.replace("unsaved");
  ui.handleInput("\x1b]"); assert.equal(state.active, "other.ts"); // Alt+]
  ui.handleInput("\x1b["); assert.equal(state.active, "file.ts"); // Alt+[
  assert(doc.buffer.dirty);
  ui.handleInput("\x17"); // Ctrl+W
  assert.match(ui.render(100).join("\n"), /type save or discard/);
  ui.handleInput("\x1b"); assert.equal(state.documents.length, 2);
  ui.handleInput("\x17"); ui.handleInput("discard"); ui.handleInput("\r");
  assert.equal(state.documents.length, 1); assert.equal(state.active, "other.ts");
});
test("palette aliases, go-to-line, and close-with-save work without function keys", async t => {
  const { ui, state, doc } = await setup(t);
  ui.handleInput("\x1b[112;6u"); // Ctrl+Shift+P
  assert.match(ui.render(100).join("\n"), /Command Palette/);
  ui.handleInput("Jump to Line"); ui.handleInput("\r");
  ui.handleInput("2:3"); ui.handleInput("\r"); assert.deepEqual(doc.buffer.cursor, { line: 1, col: 2 });
  ui.handleInput("X"); assert(doc.buffer.dirty);
  ui.handleInput("\x17"); ui.handleInput("save"); ui.handleInput("\r"); await settle(ui);
  assert.equal(state.documents.length, 0);
  assert.equal((await readFile(doc.target, "utf8")).split("\n")[1], "\tsXecond");
});
test("completion popup supports keyboard acceptance, undo, dismissal and resize", async t => {
  let stopped = 0;
  const provider: CompletionProvider = { complete: async () => [{ label: "console" }, { label: "constant" }], resolve: async item => item, stop: () => { stopped++; } };
  const { ui, doc } = await setup(t, () => provider);
  doc.buffer.selectAll(); doc.buffer.replace("con");
  ui.handleInput("\x00"); await new Promise(r => setTimeout(r, 0)); // Ctrl+Space
  assert.match(ui.render(100).join("\n"), /Completions · Tab accept/);
  for (const width of [12, 40, 100]) assert(ui.render(width).every(line => visibleWidth(line) <= width));
  ui.handleInput("\x1b[B"); ui.handleInput("\t"); await new Promise(r => setTimeout(r, 0));
  assert.equal(doc.buffer.text, "constant");
  ui.handleInput("\x1a"); assert.equal(doc.buffer.text, "con");
  ui.handleInput("\x00"); await new Promise(r => setTimeout(r, 0)); ui.handleInput("\x1b");
  assert(!ui.render(100).join("\n").includes("Completions · Tab accept"));
  assert.equal(doc.buffer.text, "con");
  paletteCommand(ui, "Disable IntelliSense"); assert.equal(stopped, 1);
});
test("five visible tabs support direct shortcuts, cycling and mouse navigation without losing edits", async t => {
  const { ui, state, doc } = await setup(t);
  for (let i = 2; i <= 5; i++) state.documents.push({ ...doc, path: `tab${i}.ts`, buffer: new TextBuffer(`tab${i}`), top: 0, left: 0 });
  doc.buffer.replace("unsaved");
  const header = ui.render(100)[1];
  assert.match(header, /file.ts/); assert.match(header, /tab5.ts/);
  ui.handleInput("\x1b5"); assert.equal(state.active, "tab5.ts"); // Alt+5
  ui.handleInput("X"); assert.equal(state.documents[4].buffer.text, "Xtab5");
  ui.handleInput("\x1b]"); assert.equal(state.active, "file.ts");
  ui.handleInput("\x1b["); assert.equal(state.active, "tab5.ts");
  ui.render(100);
  ui.handleMouse({ type: "click", button: "left", x: 33, y: 1, screenX: 33, screenY: 1,
    width: 100, height: 22, shift: false, ctrl: false, alt: false });
  assert.equal(state.active, "file.ts"); assert(doc.buffer.text.startsWith("unsaved"));
  ui.handleInput("\x02"); // Hide sidebar; tab hitboxes must follow.
  ui.render(100);
  ui.handleMouse({ type: "click", button: "left", x: 85, y: 1, screenX: 85, screenY: 1,
    width: 100, height: 22, shift: false, ctrl: false, alt: false });
  assert.equal(state.active, "tab5.ts");
  for (const width of [1, 12, 40, 100]) assert(ui.render(width).every(line => visibleWidth(line) <= width));
});
test("opening a sixth file is blocked without evicting dirty tabs; closing makes room", async t => {
  const { ui, state, doc, project } = await setup(t);
  await writeFile(join(project.root, "sixth.ts"), "sixth");
  for (let i = 2; i <= 5; i++) state.documents.push({ ...doc, path: `tab${i}.ts`, buffer: new TextBuffer(`tab${i}`) });
  doc.buffer.replace("unsaved");
  ui.handleInput("\x12"); await settle(ui);
  const openSixth = async () => { ui.handleInput("\x10"); ui.handleInput("sixth"); ui.handleInput("\r"); await settle(ui); };
  await openSixth(); assert.equal(state.documents.length, 5); assert.equal(state.active, "file.ts");
  assert.match(ui.render(100).join("\n"), /Five tabs are already open/); assert(doc.buffer.dirty);
  ui.handleInput("\x1b5"); ui.handleInput("\x17"); // Close a clean tab.
  assert.equal(state.documents.length, 4);
  await openSixth(); assert.equal(state.documents.length, 5); assert.equal(state.active, "sixth.ts");
  assert(doc.buffer.dirty);
});
function paletteCommand(ui: Workbench, query: string) { ui.handleInput("\x0b"); ui.handleInput(query); ui.handleInput("\r"); }
test("stale completion responses cannot overwrite edits and Escape cancels pending suggestions", async t => {
  let reply!: (items: CompletionItem[]) => void;
  const provider: CompletionProvider = { complete: () => new Promise(resolve => { reply = resolve; }), resolve: async item => item, stop() {} };
  const { ui, doc } = await setup(t, () => provider);
  doc.buffer.selectAll(); doc.buffer.replace("con");
  ui.handleInput("\x00"); ui.handleInput("\x1b"); reply([{ label: "console" }]);
  await new Promise(r => setTimeout(r, 0)); assert(!ui.render(100).join("\n").includes("Completions · Tab accept"));
  ui.handleInput("\x00"); doc.buffer.replace("changed"); reply([{ label: "console" }]);
  await new Promise(r => setTimeout(r, 0)); assert(!ui.render(100).join("\n").includes("Completions · Tab accept"));
  assert.equal(doc.buffer.text, "conchanged");
});
test("enabled completion triggers automatically after a dot and pending resolve cannot clobber typing", async t => {
  let calls = 0, finishResolve!: (item: CompletionItem) => void;
  const provider: CompletionProvider = {
    complete: async () => { calls++; return [{ label: "speak" }]; },
    resolve: () => new Promise(resolve => { finishResolve = resolve; }), stop() {},
  };
  const { ui, doc } = await setup(t, () => provider);
  doc.buffer.selectAll(); doc.buffer.replace("animal");
  ui.handleInput("\x00"); await new Promise(r => setTimeout(r, 0)); ui.handleInput("\x1b");
  ui.handleInput("."); await new Promise(r => setTimeout(r, 180));
  assert.equal(calls, 2); assert.match(ui.render(100).join("\n"), /Completions · Tab accept/);
  ui.handleInput("\t"); ui.handleInput("x"); finishResolve({ label: "speak" });
  await new Promise(r => setTimeout(r, 0)); assert.equal(doc.buffer.text, "animal.x");
});
