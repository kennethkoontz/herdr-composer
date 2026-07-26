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

function wrapPlain(text, width) {
  if (width <= 0) return [""];
  if (!text) return [""];
  const lines = [];
  let rest = text;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt < Math.floor(width * 0.5)) breakAt = width;
    lines.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).replace(/^\s+/, "");
  }
  lines.push(rest);
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
    createMore: !!initial.createMore,
    error: "",
    mode: "form",
    pick: null,
  };

  function currentHarness() {
    return harnesses[state.harnessIndex] || harnesses[0];
  }

  function syncModelEffortDefaults(prevHarness, nextHarness) {
    if (prevHarness === nextHarness) return;
    const models = getModels(nextHarness);
    const efforts = getEffort(nextHarness);
    if (!models.includes(state.model)) state.model = models[0] || "";
    if (!efforts.includes(state.effort)) state.effort = efforts[0] || "";
  }

  function openPick(kind) {
    let options = [];
    let index = 0;
    if (kind === "space") {
      options = spaces.map((s) => ({ value: s.id, label: s.label }));
      index = state.spaceIndex;
    } else if (kind === "harness") {
      options = harnesses.map((h) => ({
        value: h,
        label: `${harnessGlyph(h)}  ${h}`,
      }));
      index = state.harnessIndex;
    } else if (kind === "model") {
      options = getModels(currentHarness()).map((m) => ({
        value: m,
        label: m,
      }));
      index = Math.max(
        0,
        options.findIndex((o) => o.value === state.model),
      );
    } else if (kind === "effort") {
      options = getEffort(currentHarness()).map((e) => ({
        value: e,
        label: e,
      }));
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
    if (!q) return pick.options;
    return pick.options.filter((o) => o.label.toLowerCase().includes(q));
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
        ? `${INVERSE}${BOLD} ${spaceLabel} ▾ (s) ${RESET}`
        : `${BOLD}${WHITE}${spaceLabel}${RESET}${DIM} ▾ (s)${RESET}`;
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
    const wrapped = plainPrompt
      ? wrapPlain(plainPrompt, Math.max(10, inner - 2))
      : [placeholder];

    // Show caret on last prompt line when focused.
    for (let i = 0; i < bodyRows; i += 1) {
      if (i < wrapped.length) {
        const isLast = i === wrapped.length - 1;
        const isPlaceholder = !plainPrompt;
        let text = wrapped[i];
        if (isPlaceholder) {
          text = `${DIM}${text}${RESET}`;
        }
        const caret =
          promptActive && isLast ? (plainPrompt ? `${CYAN}█${RESET}` : `${DIM}█${RESET}`) : "";
        out.push(line(padX, inner, ` ${text}${caret}`));
      } else {
        out.push(line(padX, inner, ""));
      }
    }

    out.push(divider(padX, inner));

    const modelChip = chip(field === "model", "✦", shortModel(state.model), "m");
    const effortChip = chip(field === "effort", "⚡", state.effort || "effort", "e");
    const harnessChip = chip(
      field === "harness",
      harnessGlyph(harness),
      harness,
      "h",
    );
    const moreLabel = state.createMore ? "● more" : "○ more";
    const moreChip =
      field === "createMore"
        ? `${INVERSE} ${moreLabel} (o) ${RESET}`
        : `${DIM}${moreLabel}${RESET} ${DIM}(o)${RESET}`;
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
        `${DIM}↑↓ move · enter select · type to filter${RESET}`,
      ),
    );
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

  // Letter binds for settings. Plain letter works off the prompt so typing is
  // undisturbed; meta/alt+letter works from anywhere (including the prompt).
  function settingBind(str, key) {
    if (key.ctrl) return false;
    const onPrompt = fields[state.field] === "prompt";
    if (onPrompt && !key.meta) return false;

    const letter = (
      (key.name && key.name.length === 1 ? key.name : str) || ""
    ).toLowerCase();
    if (!letter || letter.length !== 1) return false;

    if (letter === "s") {
      state.field = fields.indexOf("space");
      openPick("space");
      return true;
    }
    if (letter === "m") {
      state.field = fields.indexOf("model");
      openPick("model");
      return true;
    }
    if (letter === "e") {
      state.field = fields.indexOf("effort");
      openPick("effort");
      return true;
    }
    if (letter === "h") {
      state.field = fields.indexOf("harness");
      openPick("harness");
      return true;
    }
    if (letter === "o") {
      state.field = fields.indexOf("createMore");
      state.createMore = !state.createMore;
      return true;
    }
    return false;
  }

  return new Promise((resolvePromise, reject) => {
    readline.emitKeypressEvents(process.stdin);
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
      write(SHOW + CLEAR);
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
          if (key.name === "up") {
            state.pick.index = Math.max(0, state.pick.index - 1);
            render();
            return;
          }
          if (key.name === "down") {
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
          state.prompt += str;
          state.error = "";
          render();
          return;
        }

        if (field === "prompt") {
          if (key.name === "backspace") {
            state.prompt = state.prompt.slice(0, -1);
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
            state.prompt += str;
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
          state.prompt = state.prompt.slice(0, -1);
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
