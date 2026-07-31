/**
 * `ragedocker ia …` — signing in to Claude or ChatGPT from the terminal.
 *
 *   ragedocker ia login        set up (or replace) your main AI account
 *   ragedocker ia relogin      re-enter the key for the account in use
 *   ragedocker ia secundaria   set up a second account to switch to
 *   ragedocker ia use <slot>   switch between primary and secondary
 *   ragedocker ia list         show what's configured (keys masked)
 *   ragedocker ia test         call the model once and report back
 *   ragedocker ia logout       forget an account
 *
 * A short readline wizard, not a config file to hand-edit: pick the provider,
 * paste the key, accept or change the model, and it verifies the credential
 * before saving so a typo is caught here rather than the first time the copilot
 * is used.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the SoyRage Attribution License (see LICENSE).
 */

import { createInterface, type Interface } from "node:readline";
import { color } from "../tui/ansi.js";
import { BRAND } from "../branding.js";
import {
  buildAccount,
  clearAccount,
  credentialsPath,
  loadCredentials,
  maskKey,
  PROVIDER_DEFAULTS,
  setAccount,
  useSlot,
  type AiProvider,
  type AiSlot,
} from "./credentials.js";
import { verify } from "./provider.js";

const out = (s = "") => process.stdout.write(s + "\n");

/** Prompt for a line of input, with an optional default shown in brackets. */
function ask(rl: Interface, question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? color.dim(` [${fallback}]`) : "";
  return new Promise((resolve) => rl.question(`  ${question}${suffix} `, (answer) => resolve(answer.trim() || fallback)));
}

/** Read an API key without echoing it to the terminal. */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stdout.write(`  ${question} `);
    let value = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\r" || s === "\n") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY && !wasRaw) stdin.setRawMode(false);
        process.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (s === "\x7f" || s === "\b") { value = value.slice(0, -1); return; }
      if (s === "\x03") { process.stdout.write("\n"); process.exit(130); }
      // Ignore other control characters; append printable input.
      if (s >= " ") value += s;
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Choose a provider by number. */
async function chooseProvider(rl: Interface): Promise<AiProvider> {
  out();
  out(`  ${color.bold("Which AI?")}`);
  out(`    ${color.accent("1")}  Claude       ${color.dim("(Anthropic — recommended)")}`);
  out(`    ${color.accent("2")}  ChatGPT      ${color.dim("(OpenAI)")}`);
  out(`    ${color.accent("3")}  Other        ${color.dim("(Ollama, LM Studio, any OpenAI-compatible endpoint)")}`);
  const pick = await ask(rl, "Pick 1-3", "1");
  return pick === "2" ? "openai" : pick === "3" ? "custom" : "anthropic";
}

/** The shared login flow for a slot. */
async function runLogin(slot: AiSlot, presetProvider?: AiProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existing = loadCredentials()[slot];
    const provider = presetProvider ?? (await chooseProvider(rl));
    const d = PROVIDER_DEFAULTS[provider];

    out();
    out(`  ${color.gray("Get a key here:")} ${color.brightBlue(d.console)}`);
    const key = await askSecret(`Paste your ${color.bold(d.label)} API key ${color.dim(d.keyHint)}:`);
    if (!key && provider !== "custom") {
      out(`\n  ${color.red("✗ No key entered.")}\n`);
      return;
    }

    const endpoint = provider === "custom"
      ? await ask(rl, "Endpoint (OpenAI-compatible base URL)", existing?.endpoint || d.endpoint)
      : d.endpoint;
    const model = await ask(rl, "Model", existing?.model || d.model);
    const label = await ask(rl, "Label (for your own reference)", existing?.label || d.label);

    const account = buildAccount(provider, key, model, endpoint, label);

    out(`\n  ${color.gray("Checking the credentials…")}`);
    const check = await verify(account);
    if (!check.ok) {
      out(`  ${color.red("✗ " + check.message)}`);
      const anyway = await ask(rl, "Save it anyway? (y/N)", "n");
      if (!/^y/i.test(anyway)) { out(`\n  ${color.gray("Not saved.")}\n`); return; }
    } else {
      out(`  ${color.green("✓ " + account.label + " answered: " + check.message)}`);
    }

    setAccount(slot, account);
    out(`\n  ${color.green("✓ Saved")} to ${color.dim(credentialsPath())} as the ${color.bold(slot)} account, and made active.`);
    out(`  ${color.gray("The TUI copilot (press")} ${color.accent("a")}${color.gray(") and the panel now use it.")}\n`);
  } finally {
    rl.close();
  }
}

/** Entry point dispatched from the launcher. `argv` is everything after `ia`. */
export async function runIa(argv: string[]): Promise<void> {
  const sub = (argv[0] || "login").toLowerCase();

  switch (sub) {
    case "login":
      return runLogin("primary");
    case "relogin": {
      const config = loadCredentials();
      const slot = config.active;
      return runLogin(slot, config[slot]?.provider);
    }
    case "secondary":
    case "secundaria":
      return runLogin("secondary");
    case "use":
    case "switch": {
      const target = /^sec/i.test(argv[1] || "") ? "secondary" : "primary";
      const config = useSlot(target);
      if (!config[target]) out(`\n  ${color.yellow("The " + target + " account is empty.")} Set it up with ${color.bold("ragedocker ia " + (target === "secondary" ? "secundaria" : "login"))}.\n`);
      else out(`\n  ${color.green("✓ Now using the " + target + " account")} (${config[target]!.label}).\n`);
      return;
    }
    case "list":
    case "status":
      return listAccounts();
    case "test":
    case "check": {
      const config = loadCredentials();
      const account = config[config.active];
      if (!account) { out(`\n  ${color.yellow("No AI configured.")} Run ${color.bold("ragedocker ia login")}.\n`); return; }
      out(`\n  ${color.gray("Asking " + account.label + " (" + account.model + ")…")}`);
      const check = await verify(account);
      out(check.ok ? `  ${color.green("✓ " + check.message)}\n` : `  ${color.red("✗ " + check.message)}\n`);
      return;
    }
    case "logout":
    case "clear": {
      const which = argv[1] ? (/^sec/i.test(argv[1]) ? "secondary" : "primary") : undefined;
      clearAccount(which as AiSlot | undefined);
      out(`\n  ${color.green("✓ Forgotten")} ${which ? "the " + which + " account" : "all AI accounts"}.\n`);
      return;
    }
    default:
      out(`\n  Unknown: ${color.bold("ia " + sub)}. Try: login · relogin · secundaria · use · list · test · logout\n`);
  }
}

function listAccounts(): void {
  const config = loadCredentials();
  out();
  out(`  ${color.accent(color.bold("SOYRAGE"))} ${color.gray("▸")} ${color.bold(BRAND.product)} ${color.gray("· AI accounts")}`);
  out();
  for (const slot of ["primary", "secondary"] as AiSlot[]) {
    const a = config[slot];
    const active = config.active === slot;
    const marker = active ? color.green("●") : color.gray("○");
    if (!a) {
      out(`  ${marker} ${color.bold(slot.padEnd(10))} ${color.dim("(empty)")}`);
      continue;
    }
    out(`  ${marker} ${color.bold(slot.padEnd(10))} ${a.label}  ${color.gray(a.provider)} ${color.dim(a.model)}`);
    out(`     ${color.gray("key")} ${color.dim(maskKey(a.key))}   ${color.gray("endpoint")} ${color.dim(a.endpoint)}`);
  }
  out();
  out(`  ${color.gray("Switch with")} ${color.bold("ragedocker ia use secondary")}${color.gray(", set up with")} ${color.bold("ragedocker ia login")}${color.gray(".")}`);
  out(`  ${color.gray("Stored at")} ${color.dim(credentialsPath())} ${color.gray("(owner-readable only).")}\n`);
}
