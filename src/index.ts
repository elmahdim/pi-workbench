import { copyToClipboard, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Project } from "./project.ts";
import { Workbench, type WorkbenchResult, type WorkspaceState } from "./workbench.ts";

export default function workbench(pi: ExtensionAPI) {
  const workspaces = new Map<string, WorkspaceState>();
  let active = false;
  pi.registerCommand("workbench", {
    description: "Browse, search, edit files, and review current Git changes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Workbench requires pi's interactive terminal mode", "error"); return; }
      if (active) return;
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for pi to finish before opening the workbench", "warning"); return; }
      active = true;
      let state = workspaces.get(ctx.cwd);
      if (!state) { state = { documents: [], expanded: new Set() }; workspaces.set(ctx.cwd, state); }
      const draft = ctx.ui.getEditorText();
      try {
        const result = await ctx.ui.custom<WorkbenchResult>((tui, theme, kb, done) =>
          new Workbench(tui, theme, kb, new Project(ctx.cwd), state!, withFileMutationQueue,
            text => { void copyToClipboard(text).catch(() => { /* Internal clipboard remains usable. */ }); }, done),
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
        if (result?.draft) ctx.ui.setEditorText(draft ? `${draft}\n\n${result.draft}` : result.draft);
      } finally { active = false; }
    },
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const count = [...workspaces.values()].flatMap(s => s.documents).filter(d => d.buffer.dirty).length;
    if (count && ctx.hasUI) ctx.ui.notify(`Workbench: ${count} unsaved buffer(s) will be lost on session shutdown/reload`, "warning");
    workspaces.clear();
  });
}
