import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { highlightCode, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Project, type Change } from "../src/project.ts";
import { Workbench } from "../src/workbench.ts";

initTheme("dark", false);
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "workbench-experience-"));
  await writeFile(join(root, "file.ts"), "const answer = 42;\n");
  const project = new Project(root), doc = await project.open("file.ts");
  let changes: Change[] = [], calls = 0;
  project.changes = async () => changes;
  const ui = new Workbench({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
    theme, new KeybindingsManager(TUI_KEYBINDINGS), project,
    { documents: [doc], active: doc.path, expanded: new Set() }, async (_, action) => action(), () => {}, () => {},
    () => ({ complete: async () => { calls++; return [{ label: "console" }]; }, resolve: async item => item, stop() {} }));
  t.after(async () => { ui.dispose(); await rm(root, { recursive: true, force: true }); });
  for (let i = 0; i < 200 && ui.render(100).join("\n").includes("Working…"); i++) await wait(5);
  return { ui, doc, calls: () => calls, setChanges: (value: Change[]) => { changes = value; } };
}
test("footer hides zero changes and counts changed paths once across staged/unstaged entries", async t => {
  const { ui, setChanges } = await setup(t);
  const footer = () => ui.render(100).slice(-3).join("\n");
  assert.doesNotMatch(footer(), /\b0 changes\b/);
  setChanges([{ path: "file.ts", status: "M", staged: true }, { path: "file.ts", status: "M", staged: false }] as Change[]);
  ui.handleInput("\x12"); await wait(10);
  assert.match(footer(), /1 change ·/);
  setChanges([]); ui.handleInput("\x12"); await wait(10);
  assert.doesNotMatch(footer(), /\b\d+ changes?\b/);
});
test("syntax colors survive editor focus, typing, selection, and horizontal scrolling", async t => {
  const { ui, doc } = await setup(t);
  ui.handleInput("\x0c");
  doc.buffer.move(0, doc.buffer.lines[0].length);
  ui.handleInput(" // comment");
  let line = ui.render(100)[2];
  const color = highlightCode(doc.buffer.lines[0], "typescript")[0].match(/\x1b\[[0-9;]*m/)?.[0];
  assert(color, "fixture must have syntax colors");
  assert(line.includes(color)); assert(line.includes(CURSOR_MARKER));
  doc.buffer.selectAll(); line = ui.render(100)[2]; assert(line.includes(color));
  doc.left = 5;
  for (const width of [40, 100]) assert(ui.render(width).every(value => visibleWidth(value) <= width));
});
test("typing starts completion without Ctrl+Space; disabling keeps it off until an explicit retry", async t => {
  const { ui, doc, calls } = await setup(t);
  ui.handleInput("\x0c"); doc.buffer.selectAll(); ui.handleInput("co");
  await wait(200); assert.equal(calls(), 1);
  assert.match(ui.render(100).join("\n"), /Completions · Tab accept/);
  ui.handleInput("\t"); await wait(0); assert.equal(doc.buffer.text, "console");
  ui.handleInput("\x0b"); ui.handleInput("Disable IntelliSense"); ui.handleInput("\r");
  ui.handleInput("."); await wait(200); assert.equal(calls(), 1);
  ui.handleInput("\x00"); await wait(0); assert.equal(calls(), 2);
});
