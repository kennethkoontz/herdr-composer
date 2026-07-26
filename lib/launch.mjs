import {
  allocateStartName,
  buildAgentArgs,
  clearAgentName,
  createLaunchTab,
  ensureWorkspace,
  focusAgent,
  promptAgent,
  startAgent,
} from "./herdr.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create workspace/tab and start the agent. Intended to run outside the
 * composer popup so the UI can close immediately on Create.
 *
 * Start names prefer the bare harness (`claude` / `pi`) so the sidebar label
 * never flashes a generated id. Custom names are cleared immediately after
 * start so display stays on harness kind for every agent.
 */
export async function launchSelection(selection) {
  const { space, harness, model, effort, prompt } = selection;

  const ensured = ensureWorkspace(space);
  const workspaceId = ensured.workspace_id;
  const cwd = space.cwd || ensured.cwd;

  let paneId;
  if (ensured.created && ensured.root_pane?.pane_id) {
    paneId = ensured.root_pane.pane_id;
  } else {
    const tabLabel = (prompt || harness).trim().slice(0, 24) || harness;
    const tab = createLaunchTab({
      workspaceId,
      cwd,
      label: tabLabel,
    });
    paneId = tab.pane_id;
  }

  const startName = allocateStartName(harness);
  const agentArgs = buildAgentArgs(harness, model, effort);

  await sleep(350);

  const started = startAgent({
    name: startName,
    kind: harness,
    paneId,
    agentArgs,
  });

  const targetPane = started?.agent?.pane_id || paneId;
  const target = targetPane || startName;

  // Drop custom label immediately (before prompt) so the sidebar never sits
  // on a suffixed id. When startName === harness, visible label is unchanged.
  clearAgentName(target);

  if (prompt?.trim()) {
    await sleep(150);
    promptAgent(target, prompt.trim());
  }

  focusAgent(target);

  return {
    name: harness,
    pane_id: targetPane,
    workspace_id: workspaceId,
  };
}
