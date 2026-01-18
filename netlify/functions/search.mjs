// netlify/functions/search.mjs
// Netlify Functions v2 style (Node 18+), bez __filename/__dirname hacků
// Očekává env: OPENAI_API_KEY, ASSISTANT_ID
// POST body: { message: string, thread_id?: string }
// Vrací: { ok:true, answer, thread_id }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// odstraní citace ve stylu 
function stripCitations(text = "") {
  return String(text).replace(/【\d+:\d+†[^】]+】/g, "").trim();
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const assistantId = process.env.ASSISTANT_ID;

  if (!apiKey) return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });
  if (!assistantId) return json(500, { ok: false, error: "Missing ASSISTANT_ID" });

  const body = await req.json().catch(() => ({}));
  const message = body?.message;
  let threadId = body?.thread_id || null;

  if (!message || typeof message !== "string") {
    return json(400, { ok: false, error: "Missing message" });
  }

  const OPENAI_BASE = "https://api.openai.com/v1";
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // Assistants v2 header
    "OpenAI-Beta": "assistants=v2",
  };

  try {
    // 1) thread (buď nový, nebo pokračujeme ve starém)
    if (!threadId) {
      const tRes = await fetch(`${OPENAI_BASE}/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!tRes.ok) {
        const t = await tRes.text().catch(() => "");
        return json(500, { ok: false, error: "Failed to create thread", details: t.slice(0, 500) });
      }
      const tJson = await tRes.json();
      threadId = tJson.id;
    }

    // 2) message
    const mRes = await fetch(`${OPENAI_BASE}/threads/${threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "user",
        content: message,
      }),
    });
    if (!mRes.ok) {
      const t = await mRes.text().catch(() => "");
      return json(500, { ok: false, error: "Failed to add message", details: t.slice(0, 500), thread_id: threadId });
    }

    // 3) run
    const rRes = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        assistant_id: assistantId,
      }),
    });
    if (!rRes.ok) {
      const t = await rRes.text().catch(() => "");
      return json(500, { ok: false, error: "Failed to create run", details: t.slice(0, 500), thread_id: threadId });
    }
    const run = await rRes.json();

    // 4) poll run status
    const timeoutMs = 25000;
    const start = Date.now();
    let status = run.status;

    while (status === "queued" || status === "in_progress") {
      if (Date.now() - start > timeoutMs) {
        return json(504, { ok: false, error: "Timeout waiting for response", thread_id: threadId });
      }
      await sleep(800);

      const cRes = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/${run.id}`, {
        method: "GET",
        headers,
      });
      if (!cRes.ok) {
        const t = await cRes.text().catch(() => "");
        return json(500, { ok: false, error: "Failed to retrieve run", details: t.slice(0, 500), thread_id: threadId });
      }
      const check = await cRes.json();
      status = check.status;

      if (status === "requires_action") {
        // tady by byly tool-calls, ale File Search se obslouží uvnitř Assistants automaticky
        return json(501, { ok: false, error: "Run requires_action (unexpected).", status, thread_id: threadId });
      }
    }

    if (status !== "completed") {
      return json(500, { ok: false, error: "Run failed", status, thread_id: threadId });
    }

    // 5) messages list -> vezmi poslední assistant text
    const listRes = await fetch(`${OPENAI_BASE}/threads/${threadId}/messages?limit=20`, {
      method: "GET",
      headers,
    });
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => "");
      return json(500, { ok: false, error: "Failed to list messages", details: t.slice(0, 500), thread_id: threadId });
    }

    const list = await listRes.json();
    const assistantMsg = (list.data || []).find((m) => m.role === "assistant");

    let answer = "Bez odpovědi";
    if (assistantMsg?.content?.length) {
      const parts = assistantMsg.content
        .map((c) => (c?.type === "text" ? c.text?.value : ""))
        .filter(Boolean);
      if (parts.length) answer = parts.join("\n\n");
    }

    answer = stripCitations(answer);

    return json(200, { ok: true, answer, thread_id: threadId });
  } catch (err) {
    return json(500, { ok: false, error: "Server error", details: err?.message || String(err), thread_id: threadId });
  }
}