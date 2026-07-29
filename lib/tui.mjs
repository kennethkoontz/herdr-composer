import readline from "node:readline";

import {
  readClipboardText,
  saveClipboardImage,
  writeClipboardText,
} from "./clipboard.mjs";

const ESC = "\x1b";
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;
// Bracketed paste: terminals wrap pasted text so we can accept multi-line
// paste without treating Enter as submit, and strip the markers themselves.
const BRACKETED_PASTE_ENABLE = `${ESC}[?2004h`;
const BRACKETED_PASTE_DISABLE = `${ESC}[?2004l`;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
// SGR mouse reporting: Herdr is mouse-first and does not leave drag-select to
// the outer terminal. Request events ourselves so we can select/copy text.
const MOUSE_TRACKING_ON =
  `${ESC}[?1000h` + // click
  `${ESC}[?1002h` + // drag
  `${ESC}[?1006h`; // SGR encoding
const MOUSE_TRACKING_OFF =
  `${ESC}[?1000l` +
  `${ESC}[?1002l` +
  `${ESC}[?1003l` +
  `${ESC}[?1006l`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const INVERSE = `${ESC}[7m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const WHITE = `${ESC}[37m`;

function write(text) {
  process.stdout.write(text);
}

function encode(str) {
  return String(str ?? "");
}

function stripAnsi(text) {
  return encode(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text) {
  return stripAnsi(text).length;
}

function truncate(text, max) {
  const plain = stripAnsi(text);
  if (max <= 0) return "";
  if (plain.length <= max) return text;
  if (max === 1) return "…";
  return `${plain.slice(0, max - 1)}…`;
}

function padEndVisible(text, width) {
  const pad = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

function spaceTitle(space) {
  if (!space) return "space";
  const label = space.label || "";
  return label.split(/\s{2,}/)[0] || label || "space";
}

function shortModel(model) {
  if (!model) return "model";
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

function harnessGlyph(harness) {
  switch (harness) {
    case "pi":
      return "π";
    case "claude":
      return "✶";
    case "codex":
      return "⌘";
    case "grok":
      return "χ";
    default:
      return "•";
  }
}

function chip(active, icon, label, bind) {
  const hint = bind ? `(${bind})` : "";
  const body = hint ? `${icon} ${label} ${hint}` : `${icon} ${label}`;
  if (active) return `${INVERSE}${BOLD} ${body} ${RESET}`;
  if (hint) {
    return `${DIM}${icon} ${label}${RESET} ${DIM}${hint}${RESET}`;
  }
  return `${DIM}${body}${RESET}`;
}

/**
 * Terminals often send Shift+Enter as xterm modifyOtherKeys (`CSI 27;2;13~`)
 * or Kitty keyboard protocol (`CSI 13;2u`). Node's readline does not parse the
 * former cleanly — it splits into a partial sequence plus the characters
 * "1", "3", "~", which leak into the prompt as literal `13~`.
 *
 * Reassemble / recognize those sequences. Returns:
 *   { stage: "partial" }  — consumed; wait for more bytes
 *   { stage: "done", action: "newline" | "ignore" } — full modified Enter
 *   null — not a modified-Enter sequence; handle normally
 */
function normalizePastedText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * Parse SGR mouse reports: CSI < btn ; col ; row M|m
 * Returns { button, col, row, release, motion, wheel } (col/row 1-based),
 * { partial: true } while assembling, or null when not a mouse event.
 */
function createSgrMouseParser() {
  let buf = "";

  return function feedMouse(str, key) {
    const seq = key?.sequence ?? "";

    if (seq.startsWith("\x1b[<")) {
      buf = seq;
    } else if (str && str.startsWith("\x1b[<")) {
      buf = str;
    } else if (buf) {
      // Fragmented report: digits, semicolons, final M/m.
      if (str && /^[0-9;Mm]+$/.test(str)) buf += str;
      else if (seq && /^[0-9;Mm]+$/.test(seq)) buf += seq;
      else {
        buf = "";
        return null;
      }
    } else {
      return null;
    }

    const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
    if (!m) {
      if (/^\x1b\[<[\d;]*$/.test(buf)) return { partial: true };
      buf = "";
      return null;
    }

    buf = buf.slice(m[0].length);
    const btn = Number(m[1]);
    return {
      button: btn & 3,
      col: Number(m[2]),
      row: Number(m[3]),
      release: m[4] === "m",
      motion: (btn & 32) !== 0,
      wheel: btn >= 64,
      btn,
    };
  };
}

/**
 * Track terminal bracketed-paste mode. Returns an array of events, or null
 * when this keypress is not paste-related (caller handles normally):
 *   { kind: "partial" }           — still collecting
 *   { kind: "paste", text }       — finished bracketed paste
 *   { kind: "bulk", text }        — multi-char paste without markers
 *
 * While active, every keypress is consumed so Enter does not submit.
 */
function createBracketedPasteParser() {
  let active = false;
  let buf = "";

  return {
    get active() {
      return active;
    },
    feed(str, key) {
      const seq = key?.sequence ?? "";

      if (!active) {
        // Start marker alone (typical keypress).
        if (seq === PASTE_START || str === PASTE_START) {
          active = true;
          buf = "";
          return [{ kind: "partial" }];
        }
        // Whole paste in one chunk: \x1b[200~...\x1b[201~
        const blob = str && str.length > 1 ? str : seq.length > 1 ? seq : "";
        if (blob.includes(PASTE_START)) {
          const start = blob.indexOf(PASTE_START);
          const after = blob.slice(start + PASTE_START.length);
          const end = after.indexOf(PASTE_END);
          if (end !== -1) {
            return [
              {
                kind: "paste",
                text: normalizePastedText(after.slice(0, end)),
              },
            ];
          }
          active = true;
          buf = after;
          return [{ kind: "partial" }];
        }
        // Bulk multi-char paste with no markers (common without bracketed paste).
        if (str && str.length > 1 && !key.ctrl && !key.meta) {
          return [{ kind: "bulk", text: normalizePastedText(str) }];
        }
        return null;
      }

      // --- paste active ---
      if (seq === PASTE_END || str === PASTE_END) {
        active = false;
        const text = normalizePastedText(buf);
        buf = "";
        return [{ kind: "paste", text }];
      }
      if (key?.name === "return" || key?.name === "enter") {
        buf += "\n";
        return [{ kind: "partial" }];
      }
      // Chunk may contain the end marker mid-stream.
      const chunk = str != null && str.length ? str : seq;
      if (chunk) {
        const end = chunk.indexOf(PASTE_END);
        if (end !== -1) {
          buf += chunk.slice(0, end);
          active = false;
          const text = normalizePastedText(buf);
          buf = "";
          return [{ kind: "paste", text }];
        }
        buf += chunk;
      }
      return [{ kind: "partial" }];
    },
  };
}

function createModifiedEnterParser() {
  // Buffer for fragmented `CSI 27 ; mod ; key ~` (prefix ends with `;`).
  let buf = null;

  function parseComplete(seq) {
    // xterm modifyOtherKeys: ESC [ 27 ; <mod> ; <key> ~
    let m = /^\x1b\[27;(\d+);(\d+)~$/.exec(seq);
    if (m) {
      const mod = Number(m[1]);
      const keycode = Number(m[2]);
      if (keycode !== 13) return { stage: "done", action: "ignore" };
      // mods: 1=none, 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl, …  (shift = bit0 of mod-1)
      if ((mod - 1) & 1) return { stage: "done", action: "newline" };
      return { stage: "done", action: "ignore" };
    }
    // Kitty CSI u: ESC [ <codepoint> ; <mod> u  — Enter is codepoint 13
    m = /^\x1b\[13;(\d+)u$/.exec(seq);
    if (m) {
      const mod = Number(m[1]);
      if ((mod - 1) & 1) return { stage: "done", action: "newline" };
      return { stage: "done", action: "ignore" };
    }
    if (seq === "\x1b[13u") return { stage: "done", action: "ignore" };
    return null;
  }

  return function feedModifiedEnter(str, key) {
    const seq = key?.sequence ?? "";

    // Intact sequence in one keypress event.
    if (!buf) {
      const intact = parseComplete(seq);
      if (intact) return intact;
      // Start of a split modifyOtherKeys sequence: ESC [ 27 ; mod ;
      if (/^\x1b\[27;\d+;$/.test(seq)) {
        buf = seq;
        return { stage: "partial" };
      }
      return null;
    }

    // Continue reassembly: keycode digits then '~'.
    if (str && /^[0-9]$/.test(str)) {
      buf += str;
      return { stage: "partial" };
    }
    if (str === "~" || seq === "~") {
      const full = `${buf}~`;
      buf = null;
      return parseComplete(full) || { stage: "done", action: "ignore" };
    }
    // Unexpected — drop the buffer and let this key through.
    buf = null;
    return null;
  };
}

/** Soft-wrap one paragraph; start/end are offsets into the full prompt. */
function wrapParagraph(para, width, baseOffset) {
  if (!para) return [{ text: "", start: baseOffset, end: baseOffset }];
  const lines = [];
  let offset = baseOffset;
  let rest = para;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt < Math.floor(width * 0.5)) breakAt = width;
    lines.push({
      text: rest.slice(0, breakAt),
      start: offset,
      end: offset + breakAt,
    });
    const next = rest.slice(breakAt);
    const trimmed = next.replace(/^\s+/, "");
    offset += breakAt + (next.length - trimmed.length);
    rest = trimmed;
  }
  lines.push({ text: rest, start: offset, end: offset + rest.length });
  return lines;
}

/** Word-wrap with hard newlines and source offsets so a caret can sit mid-prompt. */
function wrapIndexed(text, width) {
  if (width <= 0) return [{ text: "", start: 0, end: 0 }];
  if (!text) return [{ text: "", start: 0, end: 0 }];
  const lines = [];
  // split keeps empty segments for leading/trailing/consecutive \n
  const parts = text.split("\n");
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const para = parts[i];
    lines.push(...wrapParagraph(para, width, offset));
    offset += para.length + (i < parts.length - 1 ? 1 : 0);
  }
  return lines.length ? lines : [{ text: "", start: 0, end: 0 }];
}

/**
 * Style one wrapped prompt line: inverse selection, and a block caret on the
 * insertion cell when the caret is on this line (cursor >= 0).
 * `lineStart` is the absolute offset of `plain` in the full prompt.
 */
function stylePromptLine(plain, lineStart, { cursor, sel }) {
  const endCaret = `${INVERSE} ${RESET}`;
  if (!plain) {
    if (cursor === lineStart) return endCaret;
    return "";
  }

  let out = "";
  let inInverse = false;
  for (let i = 0; i < plain.length; i += 1) {
    const abs = lineStart + i;
    const selected = sel && abs >= sel.start && abs < sel.end;
    const isCaret = cursor === abs;
    const wantInverse = selected || isCaret;
    if (wantInverse && !inInverse) {
      out += INVERSE;
      inInverse = true;
    } else if (!wantInverse && inInverse) {
      out += RESET;
      inInverse = false;
    }
    out += plain[i];
  }
  if (inInverse) out += RESET;

  // Caret past last char on this line (EOF or wrap gap).
  if (cursor === lineStart + plain.length) {
    out += endCaret;
  }
  return out;
}

export async function runComposer({
  spaces,
  harnesses,
  getModels,
  getEffort,
  initial,
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Quick Launch needs an interactive terminal");
  }

  // Visual order matches Conductor: space → prompt → chips → actions
  const fields = [
    "space",
    "prompt",
    "model",
    "effort",
    "harness",
    "worktree",
    "createMore",
    "create",
  ];

  const state = {
    field: fields.indexOf("prompt"),
    spaceIndex: Math.max(
      0,
      spaces.findIndex((s) => s.id === initial.spaceId),
    ),
    harnessIndex: Math.max(0, harnesses.indexOf(initial.harness)),
    model: initial.model,
    effort: initial.effort,
    prompt: initial.prompt || "",
    // Insertion point in prompt (0..length). Typing/backspace edit here.
    promptCursor: (initial.prompt || "").length,
    // Selection anchor; null means no selection. Range is [min, max) of
    // anchor and cursor (exclusive end).
    promptAnchor: null,
    worktree: initial.worktree !== false,
    createMore: !!initial.createMore,
    error: "",
    status: "",
    mode: "form",
    pick: null,
    // True while left-dragging a mouse selection in the prompt.
    mouseDragging: false,
  };

  // Last painted prompt geometry for mouse hit-testing (updated in renderForm).
  let hitLayout = null;

  function clampPromptCursor() {
    state.promptCursor = Math.min(
      Math.max(0, state.promptCursor),
      state.prompt.length,
    );
  }

  function clearSelection() {
    state.promptAnchor = null;
  }

  /** Inclusive-start exclusive-end range, or null when nothing is selected. */
  function selectionRange() {
    if (state.promptAnchor == null) return null;
    const a = Math.min(state.promptAnchor, state.promptCursor);
    const b = Math.max(state.promptAnchor, state.promptCursor);
    if (a === b) return null;
    return { start: a, end: b };
  }

  function selectedText() {
    const range = selectionRange();
    if (!range) return null;
    return state.prompt.slice(range.start, range.end);
  }

  /**
   * Move caret by delta. With extend=true (shift), grow/shrink selection
   * from the existing anchor; otherwise collapse selection.
   */
  function movePromptCursor(delta, { extend = false } = {}) {
    if (extend) {
      if (state.promptAnchor == null) state.promptAnchor = state.promptCursor;
    } else {
      clearSelection();
    }
    state.promptCursor += delta;
    clampPromptCursor();
  }

  function setPromptCursor(pos, { extend = false } = {}) {
    if (extend) {
      if (state.promptAnchor == null) state.promptAnchor = state.promptCursor;
    } else {
      clearSelection();
    }
    state.promptCursor = pos;
    clampPromptCursor();
  }

  function insertPrompt(ch) {
    // Typing replaces any active selection.
    const range = selectionRange();
    if (range) {
      state.prompt =
        state.prompt.slice(0, range.start) +
        ch +
        state.prompt.slice(range.end);
      state.promptCursor = range.start + ch.length;
      clearSelection();
      return;
    }
    const i = Math.min(Math.max(0, state.promptCursor), state.prompt.length);
    state.prompt = state.prompt.slice(0, i) + ch + state.prompt.slice(i);
    state.promptCursor = i + ch.length;
  }

  function deletePromptBackward() {
    const range = selectionRange();
    if (range) {
      state.prompt =
        state.prompt.slice(0, range.start) + state.prompt.slice(range.end);
      state.promptCursor = range.start;
      clearSelection();
      return;
    }
    const i = state.promptCursor;
    if (i <= 0) return;
    state.prompt = state.prompt.slice(0, i - 1) + state.prompt.slice(i);
    state.promptCursor = i - 1;
  }

  function deletePromptForward() {
    const range = selectionRange();
    if (range) {
      state.prompt =
        state.prompt.slice(0, range.start) + state.prompt.slice(range.end);
      state.promptCursor = range.start;
      clearSelection();
      return;
    }
    const i = state.promptCursor;
    if (i >= state.prompt.length) return;
    state.prompt = state.prompt.slice(0, i) + state.prompt.slice(i + 1);
  }

  function copySelection() {
    const text = selectedText();
    if (!text) {
      state.error = "Nothing selected";
      state.status = "";
      return false;
    }
    if (writeClipboardText(text)) {
      state.error = "";
      state.status = "Copied to clipboard";
      return true;
    }
    state.error = "Could not copy to clipboard";
    state.status = "";
    return false;
  }

  function currentHarness() {
    return harnesses[state.harnessIndex] || harnesses[0];
  }

  // Reuse option arrays across opens — rebuild only when the source changes.
  const modelOptionsCache = new Map();
  const effortOptionsCache = new Map();
  const harnessOptions = harnesses.map((h) => ({
    value: h,
    label: `${harnessGlyph(h)}  ${h}`,
  }));

  function modelOptions(harness) {
    const models = getModels(harness);
    let options = modelOptionsCache.get(harness);
    // Rebuild when discovery warm replaces the underlying list reference.
    if (!options || options._source !== models) {
      options = models.map((m) => ({ value: m, label: m }));
      options._source = models;
      modelOptionsCache.set(harness, options);
    }
    return options;
  }

  function effortOptions(harness) {
    let options = effortOptionsCache.get(harness);
    if (!options) {
      options = getEffort(harness).map((e) => ({ value: e, label: e }));
      effortOptionsCache.set(harness, options);
    }
    return options;
  }

  function syncModelEffortDefaults(prevHarness, nextHarness) {
    if (prevHarness === nextHarness) return;
    const models = modelOptions(nextHarness);
    const efforts = effortOptions(nextHarness);
    if (!models.some((o) => o.value === state.model)) {
      state.model = models[0]?.value || "";
    }
    if (!efforts.some((o) => o.value === state.effort)) {
      state.effort = efforts[0]?.value || "";
    }
  }

  function openPick(kind) {
    let options = [];
    let index = 0;
    if (kind === "space") {
      options = spaces.map((s) => ({ value: s.id, label: s.label }));
      index = state.spaceIndex;
    } else if (kind === "harness") {
      options = harnessOptions;
      index = state.harnessIndex;
    } else if (kind === "model") {
      options = modelOptions(currentHarness());
      index = Math.max(
        0,
        options.findIndex((o) => o.value === state.model),
      );
    } else if (kind === "effort") {
      options = effortOptions(currentHarness());
      index = Math.max(
        0,
        options.findIndex((o) => o.value === state.effort),
      );
    }
    state.mode = "pick";
    state.pick = {
      kind,
      options,
      index: Math.min(Math.max(index, 0), Math.max(options.length - 1, 0)),
      filter: "",
      filtered: options,
      filterKey: "",
    };
  }

  function applyPick() {
    const pick = state.pick;
    if (!pick?.options.length) {
      state.mode = "form";
      state.pick = null;
      return;
    }
    const filtered = filteredPickOptions();
    const chosen = filtered[pick.index] || filtered[0] || pick.options[0];
    if (!chosen) {
      state.mode = "form";
      state.pick = null;
      return;
    }
    if (pick.kind === "space") {
      state.spaceIndex = spaces.findIndex((s) => s.id === chosen.value);
    } else if (pick.kind === "harness") {
      const prev = currentHarness();
      state.harnessIndex = harnesses.indexOf(chosen.value);
      syncModelEffortDefaults(prev, chosen.value);
    } else if (pick.kind === "model") {
      state.model = chosen.value;
    } else if (pick.kind === "effort") {
      state.effort = chosen.value;
    }
    state.mode = "form";
    state.pick = null;
  }

  function filteredPickOptions() {
    const pick = state.pick;
    if (!pick) return [];
    const q = pick.filter.trim().toLowerCase();
    if (q === pick.filterKey && pick.filtered) return pick.filtered;
    const filtered = q
      ? pick.options.filter((o) => o.label.toLowerCase().includes(q))
      : pick.options;
    pick.filterKey = q;
    pick.filtered = filtered;
    return filtered;
  }

  function submit() {
    const space = spaces[state.spaceIndex];
    if (!space) {
      state.error = "No space selected";
      return false;
    }
    return {
      space,
      harness: currentHarness(),
      model: state.model,
      effort: state.effort,
      prompt: state.prompt,
      worktree: state.worktree,
      createMore: state.createMore,
    };
  }

  function dims() {
    // Full popup surface — Herdr already draws the outer chrome/title.
    const cols = Math.max(process.stdout.columns || 80, 40);
    const rows = Math.max(process.stdout.rows || 20, 10);
    const padX = cols >= 60 ? 2 : 1;
    const width = cols;
    const inner = Math.max(20, width - padX * 2);
    return { cols, rows, padX, width, inner };
  }

  function line(padX, inner, content = "") {
    return `${" ".repeat(padX)}${padEndVisible(content, inner)}`;
  }

  function divider(padX, inner) {
    return line(padX, inner, `${DIM}${"─".repeat(inner)}${RESET}`);
  }

  function splitLine(padX, inner, left, right) {
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    if (visibleWidth(left) + visibleWidth(right) + 1 > inner) {
      const rightW = visibleWidth(right);
      const leftBudget = Math.max(8, inner - rightW - 2);
      const clipped = truncate(stripAnsi(left), leftBudget);
      const g = Math.max(1, inner - visibleWidth(clipped) - rightW);
      return line(padX, inner, `${clipped}${" ".repeat(g)}${right}`);
    }
    return line(padX, inner, `${left}${" ".repeat(gap)}${right}`);
  }

  function render() {
    const { cols, rows, padX, inner } = dims();
    const out = [];

    // Fill exactly `rows` lines so the footer sits on the bottom edge of the popup.
    if (state.mode === "pick") {
      hitLayout = null;
      renderPick(out, { cols, rows, padX, inner });
    } else {
      renderForm(out, { cols, rows, padX, inner });
    }

    while (out.length < rows) out.push("");
    const clipped = out.slice(0, rows).map((row) => {
      // Guard against accidental overflow wrapping in the host terminal.
      const plain = stripAnsi(row);
      if (plain.length <= cols) return padEndVisible(row, cols);
      return truncate(plain, cols);
    });

    // Keep mouse tracking on every paint so Herdr keeps forwarding reports.
    write(CLEAR + HIDE + MOUSE_TRACKING_ON + clipped.join("\n"));
    if (clipped.length < rows) write("\n");
  }

  /**
   * Map a 1-based mouse cell (col, row) to a prompt character offset, or null
   * when the click is outside the prompt body.
   */
  function promptOffsetAt(col, row) {
    const layout = hitLayout;
    if (!layout?.segments) return null;
    // Mouse coords are 1-based cells within the pane.
    const y = row - 1;
    const x = col - 1;
    if (y < layout.bodyStart || y >= layout.bodyStart + layout.bodyRows) {
      return null;
    }
    const lineIndex = y - layout.bodyStart;
    const segs = layout.segments;
    // Content is drawn as padX spaces + one leading space + text.
    const contentCol = x - layout.padX - 1;
    if (lineIndex >= segs.length) {
      // Empty rows below the last wrapped line → end of prompt.
      return layout.promptLength;
    }
    const seg = segs[lineIndex];
    if (contentCol <= 0) return seg.start;
    if (contentCol >= seg.text.length) {
      // Past end of this visual line: prefer the wrap gap / next line start.
      const next = segs[lineIndex + 1];
      return next ? next.start : layout.promptLength;
    }
    return seg.start + contentCol;
  }

  function renderForm(out, { rows, padX, inner }) {
    const space = spaces[state.spaceIndex];
    const harness = currentHarness();
    const field = fields[state.field];

    // Header: space only (Herdr titlebar already says Quick Launch)
    const spaceLabel = spaceTitle(space);
    const spaceChip =
      field === "space"
        ? `${INVERSE}${BOLD} ${spaceLabel} ▾ (⌥w) ${RESET}`
        : `${BOLD}${WHITE}${spaceLabel}${RESET}${DIM} ▾ (⌥w)${RESET}`;
    const pathHint = space?.cwd
      ? `${DIM}${truncate(shortPath(space.cwd), Math.max(12, inner - visibleWidth(spaceChip) - 3))}${RESET}`
      : "";

    out.push(""); // top breathing room inside popup
    out.push(splitLine(padX, inner, spaceChip, pathHint));
    out.push(divider(padX, inner));

    // Footer is 2 lines (+ optional error/status). Body gets the rest.
    const footerLines = state.error || state.status ? 3 : 2;
    const headerLines = 3; // blank + header + divider
    const bodyRows = Math.max(3, rows - headerLines - footerLines - 1);
    const bodyStart = headerLines; // row index of first prompt body line

    const placeholder = "What do you want to work on?";
    const promptActive = field === "prompt";
    const plainPrompt = state.prompt;
    clampPromptCursor();
    if (state.promptAnchor != null) {
      state.promptAnchor = Math.min(
        Math.max(0, state.promptAnchor),
        plainPrompt.length,
      );
    }
    const cursor = state.promptCursor;
    const sel = promptActive ? selectionRange() : null;
    // Placeholder only when empty and unfocused; focused empty shows just the caret.
    const showPlaceholder = !plainPrompt && !promptActive;
    const wrapWidth = Math.max(10, inner - 2);
    const segments = plainPrompt
      ? wrapIndexed(plainPrompt, wrapWidth)
      : showPlaceholder
        ? null
        : [{ text: "", start: 0, end: 0 }];

    hitLayout = {
      padX,
      bodyStart,
      bodyRows,
      wrapWidth,
      promptLength: plainPrompt.length,
      segments: segments
        ? segments.map((s) => ({ text: s.text, start: s.start, end: s.end }))
        : [{ text: "", start: 0, end: 0 }],
    };

    for (let i = 0; i < bodyRows; i += 1) {
      if (showPlaceholder && i === 0) {
        out.push(line(padX, inner, ` ${DIM}${placeholder}${RESET}`));
        continue;
      }
      if (segments && i < segments.length) {
        const seg = segments[i];
        const nextStart =
          i + 1 < segments.length ? segments[i + 1].start : plainPrompt.length;
        const onLine =
          promptActive &&
          cursor >= seg.start &&
          (cursor < nextStart || i === segments.length - 1);
        const text = promptActive
          ? stylePromptLine(seg.text, seg.start, {
              cursor: onLine ? cursor : -1,
              sel,
            })
          : seg.text;
        out.push(line(padX, inner, ` ${text}`));
      } else {
        out.push(line(padX, inner, ""));
      }
    }

    out.push(divider(padX, inner));

    const modelChip = chip(field === "model", "✦", shortModel(state.model), "⌥m");
    const effortChip = chip(field === "effort", "⚡", state.effort || "effort", "⌥e");
    const harnessChip = chip(
      field === "harness",
      harnessGlyph(harness),
      harness,
      "⌥h",
    );
    const worktreeLabel = state.worktree ? "● worktree" : "○ worktree";
    const worktreeChip =
      field === "worktree"
        ? `${INVERSE} ${worktreeLabel} (⌥t) ${RESET}`
        : `${DIM}${worktreeLabel}${RESET} ${DIM}(⌥t)${RESET}`;
    const moreLabel = state.createMore ? "● more" : "○ more";
    const moreChip =
      field === "createMore"
        ? `${INVERSE} ${moreLabel} (⌥o) ${RESET}`
        : `${DIM}${moreLabel}${RESET} ${DIM}(⌥o)${RESET}`;
    const createChip =
      field === "create"
        ? `${INVERSE}${BOLD} Create ⏎ ${RESET}`
        : `${BOLD}${WHITE}Create${RESET}${DIM} ⏎${RESET}`;

    out.push(
      splitLine(
        padX,
        inner,
        `${modelChip}  ${effortChip}  ${harnessChip}`,
        `${worktreeChip}  ${moreChip}   ${createChip}`,
      ),
    );

    if (state.error) {
      out.push(line(padX, inner, `${RED}${truncate(state.error, inner)}${RESET}`));
    } else if (state.status) {
      out.push(line(padX, inner, `${DIM}${truncate(state.status, inner)}${RESET}`));
    }
  }

  function shortPath(path) {
    const home = process.env.HOME;
    if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
    if (path === home) return "~";
    return path;
  }

  function renderPick(out, { rows, padX, inner }) {
    const pick = state.pick;
    const options = filteredPickOptions();
    const kindLabel =
      pick.kind === "space"
        ? "Space"
        : pick.kind === "model"
          ? "Model"
          : pick.kind === "effort"
            ? "Effort"
            : "Harness";

    out.push("");
    out.push(
      splitLine(
        padX,
        inner,
        `${BOLD}${kindLabel}${RESET}`,
        `${DIM}esc back${RESET}`,
      ),
    );
    out.push(divider(padX, inner));

    const filterable = pick.kind === "model" || pick.kind === "space";
    let used = 3; // blank + header + divider
    if (filterable) {
      const filterText = pick.filter || `${DIM}type to filter${RESET}`;
      out.push(
        line(
          padX,
          inner,
          ` ${DIM}filter${RESET}  ${filterText}${pick.filter !== undefined ? `${CYAN}█${RESET}` : ""}`,
        ),
      );
      used += 1;
    }

    const view = Math.max(4, rows - used - 2);
    const start = Math.max(0, pick.index - Math.floor(view / 2));
    const slice = options.slice(start, start + view);

    if (!slice.length) {
      out.push(line(padX, inner, ` ${DIM}(no matches)${RESET}`));
    }

    slice.forEach((opt, i) => {
      const abs = start + i;
      const active = abs === pick.index;
      const marker = active ? `${GREEN}❯${RESET}` : " ";
      const label = truncate(opt.label, inner - 4);
      const body = active ? `${INVERSE} ${label} ${RESET}` : label;
      out.push(line(padX, inner, `${marker} ${body}`));
    });

    while (out.length < rows - 1) out.push(line(padX, inner, ""));
    out.push(
      line(
        padX,
        inner,
        `${DIM}↑↓/^p^n move · enter select · type to filter${RESET}`,
      ),
    );
  }

  // Effort/harness are cheap; model lists warm in the background via
  // warmModelCaches so we do not block first paint on pi/grok discovery.
  for (const h of harnesses) {
    effortOptions(h);
  }

  function moveField(delta) {
    state.field = (state.field + delta + fields.length) % fields.length;
    if (fields[state.field] !== "prompt") clearSelection();
    state.error = "";
    state.status = "";
  }

  function moveFooterChip(delta) {
    const footer = [
      "model",
      "effort",
      "harness",
      "worktree",
      "createMore",
      "create",
    ];
    const current = fields[state.field];
    const idx = footer.indexOf(current);
    if (idx === -1) return false;
    const next = footer[(idx + delta + footer.length) % footer.length];
    state.field = fields.indexOf(next);
    return true;
  }

  // Settings binds: plain letter off the prompt; alt/⌥+letter from anywhere
  // (including the prompt). Avoids ctrl letter collisions (ctrl-h = backspace).
  function settingBind(str, key) {
    if (key.ctrl) return false;
    const onPrompt = fields[state.field] === "prompt";
    if (onPrompt && !key.meta) return false;

    const letter = (
      (key.name && key.name.length === 1 ? key.name : str) || ""
    ).toLowerCase();
    if (!letter || letter.length !== 1) return false;

    // Hotkeys from the prompt leave focus there so typing can continue after pick.
    const keepPrompt = onPrompt;

    if (letter === "w") {
      if (!keepPrompt) state.field = fields.indexOf("space");
      openPick("space");
      return true;
    }
    if (letter === "m") {
      if (!keepPrompt) state.field = fields.indexOf("model");
      openPick("model");
      return true;
    }
    if (letter === "e") {
      if (!keepPrompt) state.field = fields.indexOf("effort");
      openPick("effort");
      return true;
    }
    if (letter === "h") {
      if (!keepPrompt) state.field = fields.indexOf("harness");
      openPick("harness");
      return true;
    }
    if (letter === "t") {
      if (!keepPrompt) state.field = fields.indexOf("worktree");
      state.worktree = !state.worktree;
      return true;
    }
    if (letter === "o") {
      if (!keepPrompt) state.field = fields.indexOf("createMore");
      state.createMore = !state.createMore;
      return true;
    }
    return false;
  }

  return new Promise((resolvePromise, reject) => {
    // Node holds a lone ESC for 500ms by default to disambiguate it from
    // escape sequences (arrow keys etc.). 50ms is imperceptible to a human
    // but still enough for a split escape sequence to arrive over ssh/tmux.
    readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Bracketed paste + SGR mouse (select/copy in the prompt ourselves).
    write(BRACKETED_PASTE_ENABLE + MOUSE_TRACKING_ON);

    const onResize = () => {
      try {
        render();
      } catch {
        // ignore
      }
    };
    process.stdout.on("resize", onResize);

    const cleanup = () => {
      process.stdout.off("resize", onResize);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      process.stdin.removeListener("keypress", onKey);
      try {
        process.stdin.pause();
      } catch {
        // ignore
      }
      // Restore cursor only — skip full CLEAR so esc/create dismiss feels instant
      // (Herdr tears down the popup pane immediately after).
      write(BRACKETED_PASTE_DISABLE + MOUSE_TRACKING_OFF + SHOW);
    };

    const finish = (value) => {
      cleanup();
      resolvePromise(value);
    };

    const fail = (error) => {
      cleanup();
      write(SHOW);
      reject(error);
    };

    const feedModifiedEnter = createModifiedEnterParser();
    const pasteParser = createBracketedPasteParser();
    const feedMouse = createSgrMouseParser();

    const insertTextIntoPrompt = (text) => {
      if (!text) return;
      if (fields[state.field] !== "prompt") {
        state.field = fields.indexOf("prompt");
      }
      insertPrompt(text);
      state.error = "";
      state.status = "";
    };

    const insertNewlineInPrompt = () => {
      insertTextIntoPrompt("\n");
      render();
    };

    /** Handle SGR mouse for prompt select + copy-on-release (Herdr-style). */
    const handleMouse = (ev) => {
      if (ev.partial) return true;
      if (ev.wheel) return true; // swallow wheel so it does not type garbage
      if (state.mode !== "form") return true;

      // Only left button (0) for selection.
      if (ev.button !== 0 && !ev.motion) return true;

      const offset = promptOffsetAt(ev.col, ev.row);

      // Press outside prompt: clear selection, stop drag.
      if (!ev.motion && !ev.release) {
        if (offset == null) {
          state.mouseDragging = false;
          if (selectionRange()) {
            clearSelection();
            render();
          }
          return true;
        }
        // Start selection at click point; focus prompt.
        state.field = fields.indexOf("prompt");
        state.promptAnchor = offset;
        state.promptCursor = offset;
        state.mouseDragging = true;
        state.error = "";
        state.status = "";
        render();
        return true;
      }

      // Drag with button held (motion bit) or continue while mouseDragging.
      if ((ev.motion || state.mouseDragging) && !ev.release) {
        if (!state.mouseDragging) return true;
        if (offset == null) return true;
        if (fields[state.field] !== "prompt") {
          state.field = fields.indexOf("prompt");
        }
        if (state.promptAnchor == null) state.promptAnchor = offset;
        state.promptCursor = offset;
        state.error = "";
        state.status = "";
        render();
        return true;
      }

      // Release: finalize selection and copy when non-empty.
      if (ev.release) {
        if (!state.mouseDragging) return true;
        state.mouseDragging = false;
        if (offset != null) {
          state.promptCursor = offset;
        }
        if (selectionRange()) {
          copySelection();
        } else {
          clearSelection();
          state.status = "";
        }
        render();
        return true;
      }

      return true;
    };

    const onKey = (str, key) => {
      try {
        if (!key) return;

        // SGR mouse: select in prompt, copy on release.
        const mouseEv = feedMouse(str, key);
        if (mouseEv) {
          handleMouse(mouseEv);
          return;
        }

        // ctrl+c: copy the active selection when there is one; otherwise cancel.
        // While bracketed-paste is active, ignore so we don't dismiss mid-paste.
        if (key.ctrl && key.name === "c") {
          if (pasteParser.active) return;
          if (selectionRange()) {
            copySelection();
            render();
            return;
          }
          finish(null);
          return;
        }

        // Bracketed paste / bulk paste before other key logic.
        const pasteEvents = pasteParser.feed(str, key);
        if (pasteEvents) {
          let changed = false;
          for (const ev of pasteEvents) {
            if (ev.kind === "partial") continue;
            if ((ev.kind === "paste" || ev.kind === "bulk") && ev.text) {
              insertTextIntoPrompt(ev.text);
              changed = true;
            }
          }
          if (changed) render();
          // Consumed: do not fall through (avoids Enter-submit mid-paste).
          return;
        }

        // Shift+Enter (and friends) before any field logic — swallow CSI noise.
        const modEnter = feedModifiedEnter(str, key);
        if (modEnter) {
          if (modEnter.stage === "partial") return;
          if (modEnter.action === "newline") {
            // In a picker, ignore; only the prompt wants multiline.
            if (state.mode === "form") insertNewlineInPrompt();
            return;
          }
          // Known modified-enter we don't map — do not fall through to typing.
          return;
        }

        // Alt+Enter (meta+return) is another common "newline in field" binding.
        if (
          state.mode === "form" &&
          (key.name === "return" || key.name === "enter") &&
          key.meta &&
          !key.ctrl
        ) {
          insertNewlineInPrompt();
          return;
        }

        if (state.mode === "pick") {
          const options = filteredPickOptions();
          if (key.name === "escape") {
            state.mode = "form";
            state.pick = null;
            render();
            return;
          }
          if (key.name === "return") {
            applyPick();
            render();
            return;
          }
          // ↑ / ctrl-p move up; ↓ / ctrl-n move down (emacs-style).
          if (key.name === "up" || (key.ctrl && key.name === "p")) {
            state.pick.index = Math.max(0, state.pick.index - 1);
            render();
            return;
          }
          if (key.name === "down" || (key.ctrl && key.name === "n")) {
            state.pick.index = Math.min(
              Math.max(options.length - 1, 0),
              state.pick.index + 1,
            );
            render();
            return;
          }
          if (key.name === "backspace") {
            state.pick.filter = state.pick.filter.slice(0, -1);
            state.pick.index = 0;
            render();
            return;
          }
          if (str && str.length === 1 && !key.ctrl && !key.meta && str >= " ") {
            state.pick.filter += str;
            state.pick.index = 0;
            render();
            return;
          }
          return;
        }

        if (key.name === "escape") {
          finish(null);
          return;
        }

        if (settingBind(str, key)) {
          state.error = "";
          state.status = "";
          render();
          return;
        }

        // ctrl-v: image (macOS) → path at caret; otherwise clipboard text.
        // Terminal paste (cmd/ctrl+v at the host) also arrives via keypress /
        // bracketed-paste above — this path covers an explicit ^V in-app.
        if (key.ctrl && key.name === "v") {
          const imagePath = saveClipboardImage();
          if (imagePath) {
            if (fields[state.field] !== "prompt") {
              state.field = fields.indexOf("prompt");
              setPromptCursor(state.prompt.length);
            }
            const before = state.prompt[state.promptCursor - 1];
            const after = state.prompt[state.promptCursor];
            const lead = before && before !== " " && before !== "\n" ? " " : "";
            const trail = after && after !== " " && after !== "\n" ? " " : "";
            insertPrompt(`${lead}${imagePath}${trail}`);
            state.error = "";
            state.status = "";
            render();
            return;
          }
          const clipText = readClipboardText();
          if (!clipText) {
            state.error = "Clipboard is empty";
            state.status = "";
            render();
            return;
          }
          insertTextIntoPrompt(normalizePastedText(clipText));
          render();
          return;
        }

        if (key.name === "tab") {
          moveField(key.shift ? -1 : 1);
          render();
          return;
        }

        if (key.name === "up") {
          const field = fields[state.field];
          if (
            [
              "model",
              "effort",
              "harness",
              "worktree",
              "createMore",
              "create",
            ].includes(field)
          ) {
            state.field = fields.indexOf("prompt");
          } else if (field === "prompt") {
            clearSelection();
            state.field = fields.indexOf("space");
          }
          render();
          return;
        }

        if (key.name === "down") {
          const field = fields[state.field];
          if (field === "space") state.field = fields.indexOf("prompt");
          else if (field === "prompt") {
            clearSelection();
            state.field = fields.indexOf("model");
          }
          render();
          return;
        }

        if (key.name === "left" || key.name === "right") {
          const field = fields[state.field];
          const delta = key.name === "right" ? 1 : -1;

          // In the prompt, arrows move the caret; shift extends selection.
          if (field === "prompt") {
            movePromptCursor(delta, { extend: !!key.shift });
            state.error = "";
            state.status = "";
            render();
            return;
          }

          // Shift+arrows only apply in the prompt.
          if (key.shift) return;

          if (field === "harness") {
            const prev = currentHarness();
            state.harnessIndex =
              (state.harnessIndex + delta + harnesses.length) % harnesses.length;
            syncModelEffortDefaults(prev, currentHarness());
            render();
            return;
          }

          if (
            [
              "model",
              "effort",
              "harness",
              "worktree",
              "createMore",
              "create",
            ].includes(field)
          ) {
            moveFooterChip(delta);
            render();
            return;
          }
        }

        const field = fields[state.field];

        if (
          (field === "worktree" || field === "createMore") &&
          (key.name === "space" || key.name === "return")
        ) {
          if (field === "worktree") state.worktree = !state.worktree;
          else state.createMore = !state.createMore;
          render();
          return;
        }

        // Typing / bulk text anywhere jumps to prompt body.
        // Multi-char str is paste without bracketed-paste markers.
        const typing =
          str &&
          !key.ctrl &&
          !key.meta &&
          field !== "prompt" &&
          ((str.length === 1 && str >= " ") || str.length > 1);

        if (typing) {
          insertTextIntoPrompt(
            str.length > 1 ? normalizePastedText(str) : str,
          );
          render();
          return;
        }

        if (field === "prompt") {
          const extend = !!key.shift;
          // Terminal-style movement: ctrl-a/e, home/end, ctrl-b/f.
          // shift+home/end and shift+←/→ extend the selection for copy.
          if (
            key.name === "home" ||
            (key.ctrl && key.name === "a" && !key.shift)
          ) {
            setPromptCursor(0, { extend: key.name === "home" && extend });
            state.error = "";
            state.status = "";
            render();
            return;
          }
          if (
            key.name === "end" ||
            (key.ctrl && key.name === "e" && !key.shift)
          ) {
            setPromptCursor(state.prompt.length, {
              extend: key.name === "end" && extend,
            });
            state.error = "";
            state.status = "";
            render();
            return;
          }
          if (key.ctrl && key.name === "b" && !key.shift) {
            movePromptCursor(-1);
            render();
            return;
          }
          if (key.ctrl && key.name === "f" && !key.shift) {
            movePromptCursor(1);
            render();
            return;
          }
          // ctrl-k: kill to end; ctrl-u: kill to start (common readline).
          if (key.ctrl && key.name === "k") {
            clearSelection();
            state.prompt = state.prompt.slice(0, state.promptCursor);
            render();
            return;
          }
          if (key.ctrl && key.name === "u") {
            clearSelection();
            state.prompt = state.prompt.slice(state.promptCursor);
            setPromptCursor(0);
            render();
            return;
          }
          if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
            deletePromptBackward();
            render();
            return;
          }
          if (key.name === "delete" || (key.ctrl && key.name === "d")) {
            deletePromptForward();
            render();
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            // Shift+Enter inserts a newline; plain Enter creates.
            // (Some terminals set key.shift; others only send CSI — handled above.)
            if (key.shift) {
              insertNewlineInPrompt();
              return;
            }
            const value = submit();
            if (value) finish(value);
            else render();
            return;
          }
          if (str && !key.ctrl && !key.meta) {
            if (str.length === 1 && str >= " ") {
              insertPrompt(str);
              state.error = "";
              state.status = "";
              render();
              return;
            }
            if (str.length > 1) {
              insertTextIntoPrompt(normalizePastedText(str));
              render();
              return;
            }
          }
        }

        if (key.name === "return") {
          if (
            field === "space" ||
            field === "model" ||
            field === "effort" ||
            field === "harness"
          ) {
            openPick(field);
            render();
            return;
          }
          if (field === "create") {
            const value = submit();
            if (value) finish(value);
            else render();
          }
        }

        if (key.name === "backspace" && field !== "prompt" && state.prompt) {
          state.field = fields.indexOf("prompt");
          // Jump to end then delete, matching prior append-only editing.
          setPromptCursor(state.prompt.length);
          deletePromptBackward();
          render();
        }
      } catch (error) {
        fail(error);
      }
    };

    process.stdin.on("keypress", onKey);
    try {
      render();
    } catch (error) {
      fail(error);
    }
  });
}

export function printLine(message) {
  write(`${message}\n`);
}
