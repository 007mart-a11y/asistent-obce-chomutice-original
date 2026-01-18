// netlify/functions/search.mjs
// Netlify Functions (Node 18+), bez openai SDK – jen fetch
// Env vars: OPENAI_API_KEY, ASSISTANT_ID

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const OPENAI_BASE = "https://api.openai.com/v1";
const POLL_INTERVAL_MS = 800;
const TIMEOUT_MS = 25_000;

function json(resBody, status = 200) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function openaiFetch(apiKey, path, { method = "GET", body } = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Assistants v2 header (důležité)
      "OpenAI-Beta": "assistants=v2",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `OpenAI error ${res.status} on ${path}`;
    const details = data?.error || data;
    throw new Error(`${msg} :: ${JSON.stringify(details).slice(0, 600)}`);
  }

  return data;
}

function extractAssistantText(messagesList) {
  // messagesList = { data: [ ... ] }
  const msg = (messagesList?.data || []).find((m) => m.role === "assistant");
  if (!msg?.content?.length) return "Bez odpovědi";

  const parts = msg.content
    .map((c) => (c?.type === "text" ? c.text?.value : ""))
    .filter(Boolean);

  return parts.length ? parts.join("\n\n") : "Bez odpovědi";
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) return json({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);
    if (!assistantId) return json({ ok: false, error: "Missing ASSISTANT_ID" }, 500);

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return json({ ok: false, error: "Missing message" }, 400);
    }

    // (volitelné) thread_id z frontendu – když není, vytvoříme nový
    let threadId = body?.thread_id && typeof body.thread_id === "string" ? body.thread_id : null;

    if (!threadId) {
      const thread = await openaiFetch(apiKey, "/threads", { method: "POST", body: {} });
      threadId = thread.id;
    }

    // přidej user zprávu do threadu
    await openaiFetch(apiKey, `/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // spusť run
    const run = await openaiFetch(apiKey, `/threads/${threadId}/runs`, {
      method: "POST",
      body: { assistant_id: assistantId },
    });

    const started = Date.now();
    let status = run.status;

    while (status === "queued" || status === "in_progress") {
      if (Date.now() - started > TIMEOUT_MS) {
        return json({ ok: false, error: "Timeout waiting for response" }, 504);
      }
      await sleep(POLL_INTERVAL_MS);
      const check = await openaiFetch(apiKey, `/threads/${threadId}/runs/${run.id}`);
      status = check.status;

      if (status === "requires_action") {
        // pokud by někdy chtěl tool call mimo standard (neřešíme tady)
        return json(
          { ok: false, error: "Run requires action (tool call not handled).", status },
          501
        );
      }
    }

    if (status !== "completed") {
      return json({ ok: false, error: "Run failed", status }, 500);
    }

    // načti messages a vyber poslední assistant odpověď
    const messages = await openaiFetch(apiKey, `/threads/${threadId}/messages?limit=20`);
    const answer = extractAssistantText(messages);

    return json({ ok: true, answer, thread_id: threadId }, 200);
  } catch (err) {
    return json(
      { ok: false, error: "Server error", details: err?.message || String(err) },
      500
    );
  }
}