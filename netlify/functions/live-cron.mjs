import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function handler(req) {
  try {
    // ESM ekvivalent __dirname
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // live-cron.mjs je v netlify/functions -> jdeme o 2 úrovně nahoru do rootu repa
    const repoRoot = path.resolve(__dirname, "..", "..");

    // Absolutní cesta na script
    const scriptPath = path.join(repoRoot, "scripts", "upload-live-to-openai.mjs");

    const run = (cmd, args) =>
      new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: "inherit" });
        p.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`${cmd} ${args.join(" ")} failed (${code})`))
        );
      });

    // Spustí upload LIVE dat do OpenAI
    await run("node", [scriptPath]);

    return new Response(
      JSON.stringify({ ok: true, message: "LIVE cron done" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}