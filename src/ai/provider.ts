/**
 * Talking to the model — Claude natively, ChatGPT and friends over the
 * OpenAI-compatible shape.
 *
 * The two APIs differ in exactly the ways that matter here: Anthropic wants the
 * key in `x-api-key` with an `anthropic-version` header and a `system` field
 * beside `messages`, and returns the answer under `content[].text`; the OpenAI
 * shape wants `Authorization: Bearer`, folds the system prompt into the message
 * list, and returns it under `choices[].message.content`. One function per
 * provider keeps each honest rather than pretending one client fits both.
 *
 * Every call has a timeout and turns a non-2xx into a readable error — an AI
 * copilot that hangs is worse than one that says "your key was rejected".
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * MIT licensed (see LICENSE).
 */

import type { AiAccount } from "./credentials.js";

/** Ask the configured model a single question. Returns its plain-text reply. */
export async function chat(account: AiAccount, system: string, user: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return account.provider === "anthropic"
      ? await anthropic(account, system, user, controller.signal)
      : await openai(account, system, user, controller.signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("The AI request timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Claude, via the native Messages API. */
async function anthropic(account: AiAccount, system: string, user: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${account.endpoint.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": account.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: account.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(await describeError(res, "Claude"));
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  // The answer is the concatenation of the text blocks; thinking blocks, if any,
  // carry no text under the default display and drop out naturally.
  return (data.content ?? []).filter((b) => b.type === "text" || b.text).map((b) => b.text ?? "").join("").trim();
}

/** ChatGPT / Ollama / LM Studio / anything OpenAI-compatible. */
async function openai(account: AiAccount, system: string, user: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${account.endpoint.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(account.key ? { authorization: `Bearer ${account.key}` } : {}),
    },
    body: JSON.stringify({
      model: account.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(await describeError(res, account.label || "the AI endpoint"));
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/** Turn a failed HTTP response into the provider's own words where possible. */
async function describeError(res: Response, who: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    detail = typeof body.error === "string" ? body.error : body.error?.message ?? "";
  } catch { /* non-JSON error body */ }
  if (res.status === 401 || res.status === 403) return `${who} rejected the API key (${res.status}). Re-run "ragedocker ia relogin".`;
  if (res.status === 404) return `${who} has no such model or endpoint (404). Check the model name.`;
  if (res.status === 429) return `${who} is rate-limiting the request (429). Try again shortly.`;
  return `${who} returned ${res.status}${detail ? `: ${detail}` : ""}.`;
}

/**
 * A quick credential check for `ia login` / `doctor`: one tiny prompt, and a
 * boolean plus the model's echo. Never throws — a failure is a message.
 */
export async function verify(account: AiAccount): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await chat(account, "You are a health check. Reply with exactly: OK", "ping", 12000);
    return { ok: true, message: reply.slice(0, 40) || "(empty reply)" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
