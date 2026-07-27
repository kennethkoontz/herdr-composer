import readline from "node:readline";

const ESC = "\x1b";
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J${ESC}[H`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const INVERSE = `${ESC}[7m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const WHITE = `${ESC}[37m`;
const TRUE_WHITE = `${ESC}[38;2;255;255;255m`;

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

/** Word-wrap with source offsets so a caret can sit mid-prompt. */
function wrapIndexed(text, width) {
  if (width <= 0) return [{ text: "", start: 0, end: 0 }];
  if (!text) return [{ text: "", start: 0, end: 0 }];
  const lines = [];
  let offset = 0;
  let rest = text;
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
    createMore: !!initial.createMore,
    error: "",
    mode: "form",
    pick: null,
  };

  function clampPromptCursor() {
    state.promptCursor = Math.min(
      Math.max(0, state.promptCursor),
      state.prompt.length,
    );
  }

  function movePromptCursor(delta) {
    state.promptCursor += delta;
    clampPromptCursor();
  }

  function setPromptCursor(pos) {
    state.promptCursor = pos;
    clampPromptCursor();
  }

  function insertPrompt(ch) {
    const i = Math.min(Math.max(0, state.promptCursor), state.prompt.length);
    state.prompt = state.prompt.slice(0, i) + ch + state.prompt.slice(i);
    state.promptCursor = i + ch.length;
  }

  function deletePromptBackward() {
    const i = state.promptCursor;
    if (i <= 0) return;
    state.prompt = state.prompt.slice(0, i - 1) + state.prompt.slice(i);
    state.promptCursor = i - 1;
  }

  function deletePromptForward() {
    const i = state.promptCursor;
    if (i >= state.prompt.length) return;
    state.prompt = state.prompt.slice(0, i) + state.prompt.slice(i + 1);
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

    write(CLEAR + HIDE + clipped.join("\n"));
    if (clipped.length < rows) write("\n");
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

    // Footer is 2 lines (+ optional error). Body gets the rest.
    const footerLines = state.error ? 3 : 2;
    const headerLines = 3; // blank + header + divider
    const bodyRows = Math.max(3, rows - headerLines - footerLines - 1);

    const placeholder = "What do you want to work on?";
    const promptActive = field === "prompt";
    const plainPrompt = state.prompt;
    clampPromptCursor();
    const cursor = state.promptCursor;
    // Placeholder only when empty and unfocused; focused empty shows just the caret.
    const showPlaceholder = !plainPrompt && !promptActive;
    const wrapWidth = Math.max(10, inner - 2);
    const segments = plainPrompt
      ? wrapIndexed(plainPrompt, wrapWidth)
      : showPlaceholder
        ? null
        : [{ text: "", start: 0, end: 0 }];

    // Block caret at the insertion point (not always at the end).
    const caretMark = `${TRUE_WHITE}█${RESET}`;
    for (let i = 0; i < bodyRows; i += 1) {
      if (showPlaceholder && i === 0) {
        out.push(line(padX, inner, ` ${DIM}${placeholder}${RESET}`));
        continue;
      }
      if (segments && i < segments.length) {
        const seg = segments[i];
        const nextStart =
          i + 1 < segments.length ? segments[i + 1].start : plainPrompt.length;
        let text = seg.text;
        if (promptActive) {
          // Caret on this line when cursor is in [start, end], or in the
          // whitespace gap before the next wrap line (show at end of this line).
          const onLine =
            cursor >= seg.start &&
            (cursor < nextStart || i === segments.length - 1);
          if (onLine) {
            const col = Math.min(Math.max(0, cursor - seg.start), text.length);
            text = `${text.slice(0, col)}${caretMark}${text.slice(col)}`;
          }
        }
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
        `${moreChip}   ${createChip}`,
      ),
    );

    if (state.error) {
      out.push(line(padX, inner, `${RED}${truncate(state.error, inner)}${RESET}`));
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
    state.error = "";
  }

  function moveFooterChip(delta) {
    const footer = ["model", "effort", "harness", "createMore", "create"];
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
      write(SHOW);
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

    const onKey = (str, key) => {
      try {
        if (!key) return;

        if (key.ctrl && key.name === "c") {
          finish(null);
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
          if (["model", "effort", "harness", "createMore", "create"].includes(field)) {
            state.field = fields.indexOf("prompt");
          } else if (field === "prompt") {
            state.field = fields.indexOf("space");
          }
          render();
          return;
        }

        if (key.name === "down") {
          const field = fields[state.field];
          if (field === "space") state.field = fields.indexOf("prompt");
          else if (field === "prompt") state.field = fields.indexOf("model");
          render();
          return;
        }

        if (key.name === "left" || key.name === "right") {
          const field = fields[state.field];
          const delta = key.name === "right" ? 1 : -1;

          // In the prompt, arrows move the caret (not form fields).
          if (field === "prompt") {
            movePromptCursor(delta);
            render();
            return;
          }

          if (field === "harness") {
            const prev = currentHarness();
            state.harnessIndex =
              (state.harnessIndex + delta + harnesses.length) % harnesses.length;
            syncModelEffortDefaults(prev, currentHarness());
            render();
            return;
          }

          if (["model", "effort", "harness", "createMore", "create"].includes(field)) {
            moveFooterChip(delta);
            render();
            return;
          }
        }

        const field = fields[state.field];

        if (
          field === "createMore" &&
          (key.name === "space" || key.name === "return")
        ) {
          state.createMore = !state.createMore;
          render();
          return;
        }

        // Typing anywhere jumps to prompt body.
        const typing =
          str &&
          str.length === 1 &&
          !key.ctrl &&
          !key.meta &&
          str >= " " &&
          field !== "prompt";

        if (typing) {
          state.field = fields.indexOf("prompt");
          insertPrompt(str);
          state.error = "";
          render();
          return;
        }

        if (field === "prompt") {
          // Terminal-style movement: ctrl-a/e, home/end, ctrl-b/f.
          if (
            key.name === "home" ||
            (key.ctrl && key.name === "a")
          ) {
            setPromptCursor(0);
            render();
            return;
          }
          if (
            key.name === "end" ||
            (key.ctrl && key.name === "e")
          ) {
            setPromptCursor(state.prompt.length);
            render();
            return;
          }
          if (key.ctrl && key.name === "b") {
            movePromptCursor(-1);
            render();
            return;
          }
          if (key.ctrl && key.name === "f") {
            movePromptCursor(1);
            render();
            return;
          }
          // ctrl-k: kill to end; ctrl-u: kill to start (common readline).
          if (key.ctrl && key.name === "k") {
            state.prompt = state.prompt.slice(0, state.promptCursor);
            render();
            return;
          }
          if (key.ctrl && key.name === "u") {
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
          if (key.name === "return") {
            const value = submit();
            if (value) finish(value);
            else render();
            return;
          }
          if (str && str.length === 1 && !key.ctrl && !key.meta && str >= " ") {
            insertPrompt(str);
            state.error = "";
            render();
            return;
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
