// netlify/functions/search.mjs
// Netlify Functions (Node 18+, ESM)
// Requires: npm i openai
//
// DULEZITE:
// Aby tohle umelo cist soubory z /public/knowledge na produkci,
// musi byt v netlify.toml v [functions] included_files = ["public/**"]
//
// Ocekavany request body:
// { "message": "..." , "thread_id": "thread_..."? }
//
// Response:
// { ok:true, answer, thread_id }  nebo { ok:false, error, details? }

import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zkusime par bezpecnych lokaci, kde by mohl byt repozitar pri buildu/runtime
function candidatePaths(rel) {
  const relNorm = rel.replace(/^[\\/]+/, "");
  return [
    path.join(process.cwd(), relNorm),
    path.join(__dirname, "..", "..", relNorm), // netlify/functions/ -> root
  ];
}

async function readTextIfExists(relPath) {
  for (const p of candidatePaths(relPath)) {
    try {
      const txt = await fs.readFile(p, "utf8");
      return { ok: true, path: p, text: txt };
    } catch (_) {}
  }
  return { ok: false, path: null, text: "" };
}

function stripCitations(s) {
  // odstrani „“ apod.
  return String(s || "").replace(/【\d+:\d+†[^】]+】/g, "").trim();
}

export default async function handler(req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const assistantId = process.env.ASSISTANT_ID;

    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!assistantId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing ASSISTANT_ID" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const message = body?.message;

    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing message" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1) Nacti CORE + LIVE data z /public/knowledge (pokud existuji)
    const core = await readTextIfExists("public/knowledge/00_CORE_obec_chomutice.txt");
    const live = await readTextIfExists("public/knowledge/10_LIVE_obec_chomutice.txt");

    // 2) Sestav kontext (CORE ma prioritu)
    const contextParts = [];
    if (core.ok && core.text.trim()) {
      contextParts.push(`=== 00_CORE (primarni overene info, ma prednost) ===\n${core.text.trim()}`);
    }
    if (live.ok && live.text.trim()) {
      contextParts.push(`=== 10_LIVE (aktuality, rozhlas, kalendar – pravidelne generovane) ===\n${live.text.trim()}`);
    }

    const contextText = contextParts.length
      ? contextParts.join("\n\n")
      : "(Zadne lokalni knowledge soubory se nepodarilo nacist.)";

    const client = new OpenAI({ apiKey });

    // 3) Thread: bud pokracuj, nebo vytvor novy
    let threadId = typeof body.thread_id === "string" && body.thread_id.startsWith("thread_")
      ? body.thread_id
      : null;

    if (!threadId) {
      const thread = await client.beta.threads.create();
      threadId = thread.id;

      // System instrukce + knowledge (vlozime jen pri zalozeni threadu)
      await client.beta.threads.messages.create(threadId, {
        role: "system",
        content:
`Jsi „Asistent obce Chomutice“.
Odpovidej cesky, vecne a kratce.
Pouzivej POUZE informace z prilozenych podkladu (CORE a LIVE).
- Kdyz je konflikt: vyhrava 00_CORE.
- Kdyz odpoved v podkladech neni: rekni to narovinu a doporuc overeni na oficialnim webu obce.
- Nevymyslej si.

${contextText}`,
      });
    }

    // 4) Uzivatelova zprava
    await client.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
    });

    // 5) Run
    const run = await client.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    });

    // 6) Polling + timeout
    const started = Date.now();
    const timeoutMs = 30_000;
    let status = "queued";

    while (true) {
      if (Date.now() - started > timeoutMs) {
        return new Response(JSON.stringify({ ok: false, error: "Timeout waiting for response" }), {
          status: 504,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await new Promise((r) => setTimeout(r, 800));
      const check = await client.beta.threads.runs.retrieve(threadId, run.id);
      status = check.status;

      if (status === "queued" || status === "in_progress") continue;

      if (status === "requires_action") {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Run requires action (tool call not handled in function).",
            status,
          }),
          { status: 501, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      break;
    }

    if (status !== "completed") {
      return new Response(JSON.stringify({ ok: false, error: "Run failed", status }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 7) Vytahni posledni assistant odpoved
    const messages = await client.beta.threads.messages.list(threadId, { limit: 20 });

    const assistantMsg = messages.data.find((m) => m.role === "assistant");

    let answerText = "Bez odpovědi";
    if (assistantMsg?.content?.length) {
      const parts = assistantMsg.content
        .map((c) => (c?.type === "text" ? c.text?.value : ""))
        .filter(Boolean);
      if (parts.length) answerText = parts.join("\n\n");
    }

    answerText = stripCitations(answerText);

    return new Response(JSON.stringify({ ok: true, answer: answerText, thread_id: threadId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Server error",
        details: err?.message || String(err),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}