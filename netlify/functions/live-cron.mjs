// live-cron.mjs (Netlify Function, ESM)
// Spouští upload LIVE dat do OpenAI (vector store) – volitelně i scrape

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function getSecretFromReq(req) {
  const url = new URL(req.url);
  // povolíme buď header, nebo query param
  return (
    req.headers.get("x-cron-secret") ||
    url.searchParams.get("key") ||
    ""
  );
}

function runCmd(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      console.log(s.trimEnd());
    });

    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      console.error(s.trimEnd());
    });

    p.on("error", reject);

    p.on("close", (code) => {
      if (code === 0) resolve({ code, out, err });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (code ${code})\n${err || out}`));
    });
  });
}

export default async function handler(req) {
  try {
    // 1) Zabezpečení (doporučené)
    const CRON_SECRET = process.env.CRON_SECRET || "";
    if (CRON_SECRET) {
      const provided = getSecretFromReq(req);
      if (provided !== CRON_SECRET) {
        return json(401, { ok: false, error: "Unauthorized (missing/invalid CRON secret)." });
      }
    }

    // 2) Root projektu (důležité kvůli relativním cestám)
    // live-cron.mjs je v netlify/functions -> root je o 2 úrovně výš
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..", "..");

    // 3) Rychlá kontrola env (ať hned víš proč to padá)
    const required = ["OPENAI_API_KEY", "VECTOR_STORE_ID"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      return json(500, {
        ok: false,
        error: "Missing required env vars.",
        missing,
        hint: "Doplň je v Netlify → Site configuration → Environment variables (Production).",
      });
    }

    const RUN_SCRAPE = (process.env.RUN_SCRAPE || "0") === "1";

    const startedAt = new Date().toISOString();
    const steps = [];

    // 4) Volitelně SCRAPE
    if (RUN_SCRAPE) {
      steps.push({ step: "scrape", status: "running" });
      const r1 = await runCmd("npm", ["run", "scrape"], {
        cwd: projectRoot,
        env: process.env,
      });
      steps[steps.length - 1] = { step: "scrape", status: "ok", code: r1.code };
    }

    // 5) UPLOAD do OpenAI (tvoje pipeline)
    steps.push({ step: "upload-live-to-openai", status: "running" });
    const r2 = await runCmd("node", ["scripts/upload-live-to-openai.mjs"], {
      cwd: projectRoot,
      env: process.env,
    });
    steps[steps.length - 1] = { step: "upload-live-to-openai", status: "ok", code: r2.code };

    const finishedAt = new Date().toISOString();

    return json(200, {
      ok: true,
      message: "LIVE cron done",
      startedAt,
      finishedAt,
      ranScrape: RUN_SCRAPE,
      steps,
      // poslední výstup pro rychlé debugování
      tail: (r2.out || "").split("\n").slice(-60).join("\n"),
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err?.message || String(err),
    });
  }
}