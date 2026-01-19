export default async function handler(req) {
  // Netlify Scheduled Functions volají GET (není to veřejné API), ale přesto vrátíme JSON.
  try {
    // Tady voláme tvůj existující pipeline script:
    // - vygeneruje LIVE soubor (scrape)
    // - nahraje ho do OpenAI (upload do vector store / assistant files) – jak už máte otestované
    const { spawn } = await import("node:child_process");

    const run = (cmd, args) =>
      new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: "inherit" });
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (${code})`))));
      });

    // 1) Scrape (nebo pokud už scrape dělá upload-script sám, klidně tuhle řádku smaž)
    // await run("npm", ["run", "scrape"]);

    // 2) Upload do OpenAI (POUŽIJ přesně název tvého scriptu)
    // Pokud se tvůj script jmenuje jinak, jen přepiš cestu:
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
