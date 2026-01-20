export default async function handler(req) {
  try {
    const { spawn } = await import("node:child_process");

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
    await run("node", ["scripts/upload-live-to-openai.mjs"]);

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