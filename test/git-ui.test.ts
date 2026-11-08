import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { Project, run } from "../src/project.ts";
import { Workbench, type WorkspaceState } from "../src/workbench.ts";
initTheme("dark", false);
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
const baseline = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join("\n") + "\n";
async function settle(ui: Workbench) {
  for (let n = 0; n < 300; n++) {
    if (!ui.render(180).join("\n").includes("Working…")) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("UI task timed out");
}
const palette = (ui: Workbench, query: string) => { ui.handleInput("\x0b"); ui.handleInput(query); ui.handleInput("\r"); };
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "workbench-git-ui-")), file = join(root, "file.ts");
  await run(root, "git", ["init", "-q"]); await run(root, "git", ["config", "user.name", "Test"]);
  await run(root, "git", ["config", "user.email", "test@example.com"]); await writeFile(file, baseline);
  await run(root, "git", ["add", "."]); await run(root, "git", ["commit", "-qm", "base"]);
  await writeFile(file, baseline.replace("line 2\n", "first\n").replace("line 28\n", "last\n"));
  const p = new Project(root), doc = await p.open("file.ts"), state: WorkspaceState = { documents: [doc], active: doc.path, expanded: new Set() };
  const ui = new Workbench({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
    new KeybindingsManager(TUI_KEYBINDINGS), p, state, async (_path, action) => action(), () => {}, () => {});
  t.after(async () => { ui.dispose(); await rm(root, { recursive: true, force: true }); });
  await settle(ui);
  const review = async () => { palette(ui, "Review Current Changes"); ui.handleInput("\r"); await settle(ui); };
  return { ui, p, state, doc, file, review };
}
test("diff review offers visible back-to-editor controls and preserves editor position", async t => {
  const { ui, doc, review } = await fixture(t); doc.buffer.move(10, 3);
  await review(); assert.match(ui.render(180).join("\n"), /Back to editor/);
  ui.handleInput("\x1b"); let screen = ui.render(180).join("\n");
  assert(!screen.includes("DIFF file.ts")); assert(screen.includes(CURSOR_MARKER)); assert.equal(doc.buffer.cursor.line, 10);
  assert.match(screen, /  files/); assert(!screen.includes("wrk M file.ts"));
  await review(); ui.handleInput("\x1b[1;3D"); // Alt+Left
  screen = ui.render(180).join("\n");
  assert(!screen.includes("DIFF file.ts")); assert.match(screen, /  files/);
  palette(ui, "Review Current Changes"); ui.handleInput("\x1b");
  assert.match(ui.render(180).join("\n"), /  files/);
  await review(); ui.handleInput("\x1be"); await settle(ui); // Alt+E edits reviewed file.
  assert(!ui.render(180).join("\n").includes("DIFF file.ts"));
});
test("whole-file revert requires exact confirmation, refreshes buffer, and returns to editor", async t => {
  const { ui, doc, file, review } = await fixture(t); await review();
  palette(ui, "Revert File Changes"); await settle(ui);
  assert.match(ui.render(180).join("\n"), /Type revert to confirm/);
  ui.handleInput("no"); ui.handleInput("\r"); assert((await readFile(file, "utf8")).includes("first"));
  palette(ui, "Revert File Changes"); await settle(ui); ui.handleInput("revert"); ui.handleInput("\r"); await settle(ui);
  assert.equal(await readFile(file, "utf8"), baseline); assert.equal(doc.buffer.text, baseline);
  assert(!ui.render(180).join("\n").includes("DIFF file.ts"));
});
test("current-hunk revert targets the navigated hunk and retains other changes", async t => {
  const { ui, file, review } = await fixture(t); await review();
  ui.handleInput("\x1b[1;3B"); // Alt+Down selects hunk 2.
  assert.match(ui.render(180).join("\n"), /Hunk 2\/2/);
  palette(ui, "Revert Current Hunk"); await settle(ui); ui.handleInput("revert"); ui.handleInput("\r"); await settle(ui);
  const text = await readFile(file, "utf8"); assert(text.includes("first")); assert(!text.includes("last"));
  assert.match(ui.render(180).join("\n"), /Hunk 1\/1/);
});
test("unsaved workbench edits and files changed during confirmation block revert", async t => {
  const { ui, doc, file, review } = await fixture(t);
  doc.buffer.replace("unsaved"); await review(); palette(ui, "Revert File Changes"); await settle(ui);
  assert.match(ui.render(180).join("\n"), /Revert blocked/); assert(doc.buffer.text.includes("unsaved"));
  doc.buffer.undo(); palette(ui, "Revert File Changes"); await settle(ui);
  await writeFile(file, "external edit\n"); ui.handleInput("revert"); ui.handleInput("\r"); await settle(ui);
  assert.equal(await readFile(file, "utf8"), "external edit\n"); assert.match(ui.render(180).join("\n"), /Diff changed/);
});
