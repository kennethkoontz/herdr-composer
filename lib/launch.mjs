import {
  agentStatus,
  allocateStartName,
  buildAgentArgs,
  clearAgentName,
  createLaunchTab,
  createWorktree,
  ensureWorkspace,
  explainAgent,
  focusAgent,
  promptAgent,
  readAgentScreen,
  sendKeysAgent,
  startAgent,
  worktreeBranch,
} from "./herdr.mjs";

const PANE_BUSY_TIMEOUT_MS = 10000;
const PROMPT_READY_TIMEOUT_MS = 120000;
const POLL_MS = 400;
const SUBMIT_CONFIRM_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the pane shows a modal choice list instead of a prompt box — the
 * folder-trust check ("Yes, I trust this folder" / "allow … to work in this
 * folder") and other first-run pickers. Submitting a prompt here is worse than
 * losing it: the text lands as keystrokes in a numbered menu, so a digit in the
 * prompt can select "No, exit" and the trailing Enter confirms it.
 *
 * Wording is matched loosely on purpose; the numbered-choice shape is the real
 * signal, so this keeps working when a harness rewords its dialog.
 */
export function looksLikeStartupDialog(text) {
  if (!text) return false;

  const lines = text.split(/\r?\n/);
  const options = lines.filter((line) =>
    /^\s*[❯>›»*]?\s*[1-9]\.\s+\S/.test(line),
  );
  if (options.length < 2) return false;

  const yesNoChoice = options.some((line) =>
    /^\s*[❯>›»*]?\s*[1-9]\.\s+(yes|no)\b/i.test(line),
  );
  const trustWording =
    /do you trust|trust this folder|trust the files|allow .{0,40}\bto work in|without asking for approval|is this a project you (created|trust)/i.test(
      text,
    );

  return yesNoChoice || trustWording;
}

function isBlocked(detail) {
  if (!detail) return false;
  return detail.state === "blocked" || detail.visible_blocker === true;
}

/**
 * `agent start` needs the pane sitting at its shell prompt. A freshly created
 * pane can still be sourcing the user's shell profile, which fails with
 * `agent_pane_busy`, so retry for a bit instead of dropping the launch.
 */
async function startAgentWhenPaneReady(options) {
  const deadline = Date.now() + PANE_BUSY_TIMEOUT_MS;
  let delay = 250;

  while (true) {
    try {
      return startAgent(options);
    } catch (error) {
      if (error?.code !== "agent_pane_busy" || Date.now() >= deadline) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 1500);
    }
  }
}

/**
 * Wait until the harness is really taking input. Herdr reports a known agent as
 * idle even while its folder-trust dialog is up (detection falls back to idle
 * when no rule matches), so readiness is gated on the screen and on herdr's
 * blocker detection rather than on `agent start` returning.
 */
export async function waitForPromptReady(
  target,
  { timeoutMs = PROMPT_READY_TIMEOUT_MS, pollMs = POLL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let waited = false;

  while (true) {
    const screen = readAgentScreen(target);
    const dialog = looksLikeStartupDialog(screen);
    const blocked = !dialog && isBlocked(explainAgent(target));

    if (!dialog && !blocked) {
      // Let the prompt box repaint after a dialog closes before typing into it.
      if (waited) await sleep(800);
      return { ready: true, waited };
    }

    if (Date.now() >= deadline) {
      return { ready: false, waited: true, reason: dialog ? "dialog" : "blocked" };
    }

    waited = true;
    await sleep(pollMs);
  }
}

/**
 * A harness that just closed its trust dialog can still be re-initialising and
 * drop the Enter that `agent prompt` sends, leaving the text typed but never
 * submitted. If the agent has not started working, press Enter once more —
 * harmless on an already-submitted (empty) prompt box.
 */
export async function confirmSubmitted(
  target,
  { timeoutMs = SUBMIT_CONFIRM_MS, pollMs = POLL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (agentStatus(target) !== "idle") return { submitted: true, nudged: false };
  }

  sendKeysAgent(target, "enter");
  await sleep(pollMs);
  return { submitted: agentStatus(target) !== "idle", nudged: true };
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
  const { space, harness, model, effort, prompt, worktree } = selection;

  const ensured = worktree
    ? createWorktree(space, {
        branch: worktreeBranch(prompt, harness),
        label:
          (prompt || harness).trim().replace(/\s+/g, " ").slice(0, 48) ||
          harness,
      })
    : ensureWorkspace(space);
  const workspaceId = ensured.workspace_id;
  const cwd = ensured.cwd || space.cwd;

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

  const started = await startAgentWhenPaneReady({
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

  // Focus before waiting: a trust dialog can only be answered on a visible pane.
  focusAgent(target);

  let promptSent = false;
  let promptSkipped = null;
  let promptNudged = false;
  let promptStalled = false;
  if (prompt?.trim()) {
    await sleep(150);
    const ready = await waitForPromptReady(target, {
      timeoutMs: selection.promptReadyTimeoutMs || PROMPT_READY_TIMEOUT_MS,
      pollMs: selection.promptPollMs || POLL_MS,
    });
    if (ready.ready) {
      promptAgent(target, prompt.trim());
      promptSent = true;
      // Only the post-dialog path is known to drop the submit keystroke, and
      // `idle` is only a reliable signal for harnesses with a real idle rule —
      // so do not poll (or nudge) after an ordinary start.
      if (ready.waited) {
        const confirmed = await confirmSubmitted(target, {
          timeoutMs: selection.submitConfirmMs ?? SUBMIT_CONFIRM_MS,
          pollMs: selection.promptPollMs || POLL_MS,
        });
        promptNudged = confirmed.nudged;
        promptStalled = confirmed.nudged && !confirmed.submitted;
      }
    } else {
      promptSkipped = ready.reason;
    }
  }

  return {
    name: harness,
    pane_id: targetPane,
    workspace_id: workspaceId,
    prompt_sent: promptSent,
    prompt_skipped: promptSkipped,
    prompt_nudged: promptNudged,
    prompt_stalled: promptStalled,
  };
}
