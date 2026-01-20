import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handler() {
  try {
    const run = (cmd, args) =>
      new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: "inherit" });
        p.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`${cmd} ${args.join(" ")} failed (${code})`))
        );
      });

    // ⬅️ ABSOLUTNÍ CESTA K SCRIPTU
    const scriptPath = path.join(
      __dirname,
      "..",
      "..",
      "scripts",
      "upload-live-to-openai.mjs"
    );

    await run("node", [scriptPath]);

    return new Response(
      JSON.stringify({ ok: true, message: "LIVE cron done" }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500 }
    );
  }
}