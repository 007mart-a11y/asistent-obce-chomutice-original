// scripts/live_chomutice_scrape.mjs
// Node 18+
// npm i cheerio

import fs from "fs";
import path from "path";
import os from "os";
import * as cheerio from "cheerio";

const BASE = "https://www.obec-chomutice.cz";

// --- helper: safe env
const cleanEnv = (v) =>
  (v || "")
    .trim()
    .replace(/^[\s"'“”]+/, "")
    .replace(/[\s"'“”]+$/, "");

// ---- where to write
// Priority:
// 1) LIVE_FILE_PATH env (absolute or relative)
// 2) If Netlify/serverless: /tmp/knowledge/10_LIVE...
// 3) Local dev: public/knowledge/10_LIVE...
function resolveOutPath() {
  const explicit = cleanEnv(process.env.LIVE_FILE_PATH);
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(process.cwd(), explicit);
  }

  const isServerless =
    !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (isServerless) {
    return path.join(os.tmpdir(), "knowledge", "10_LIVE_obec_chomutice.txt");
  }

  return path.join(
    process.cwd(),
    "public",
    "knowledge",
    "10_LIVE_obec_chomutice.txt"
  );
}

const OUT_PATH = resolveOutPath();

// limity
const NEWS_LIMIT = 20;
const BROADCAST_LIMIT = 20;
const EVENTS_LIMIT = 10;

function nowISO() {
  return new Date().toISOString();
}

function cleanText(str) {
  if (!str) return "";
  return String(str)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return BASE + href;
  return BASE + "/" + href;
}

// ✅ DŮLEŽITÉ: očistí URL o běžnou interpunkci na konci,
// aby se z "....html." nestal 404 nebo neklikací link.
function stripTrailingPunctuationFromUrl(url) {
  if (!url) return "";
  // remove trailing punctuation that often gets glued to URL in text
  // includes: ., , ; : ) ] } ! ? and also Unicode variants
  return String(url).replace(/[)\]}.,;:!?…]+$/g, "");
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "ChomuticeBot/1.0",
      "Accept-Language": "cs",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${url}`);
  }

  return await res.text();
}

/* =========================
   HOMEPAGE – provozní info
========================= */
function extractHomepageNotice($) {
  const notices = [];
  const keywords = /(uzavřen|uzavřena|uzavřeno|mimořádn|omezen|dovolen)/i;

  $("p, li").each((_, el) => {
    const text = cleanText(
      $(el)
        .clone()
        .children()
        .remove()
        .end()
        .text()
    );

    if (text && text.length > 15 && text.length < 200 && keywords.test(text)) {
      notices.push(text);
    }
  });

  return [...new Set(notices)].slice(0, 3);
}

/* =========================
   AKTUALITY
========================= */
async function scrapeAktuality() {
  const url = `${BASE}/aktuality-1/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const items = [];

  $(".event.readable_item").each((_, el) => {
    const title = cleanText($(el).find("h3.title").text());
    const href = $(el).find("h3.title a").attr("href");
    const date = cleanText($(el).find(".publication_date").text());
    const perex = cleanText($(el).find(".perex").text());

    if (!title || !href) return;

    items.push({
      title,
      date,
      perex,
      url: stripTrailingPunctuationFromUrl(absUrl(href)),
    });
  });

  return { url, items: items.slice(0, NEWS_LIMIT) };
}

/* =========================
   ROZHLAS
========================= */
async function scrapeRozhlas() {
  const url = `${BASE}/hlaseni-rozhlasu/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const items = [];

  $(".event.readable_item").each((_, el) => {
    const title = cleanText($(el).find("h3.title").text());
    const href = $(el).find("a").attr("href");
    const date = cleanText($(el).find(".publication_date").text());
    const perex = cleanText($(el).find(".perex").text());

    if (!title || !href) return;

    items.push({
      title,
      date,
      perex,
      url: stripTrailingPunctuationFromUrl(absUrl(href)),
    });
  });

  return { url, items: items.slice(0, BROADCAST_LIMIT) };
}

/* =========================
   KALENDÁŘ AKCÍ
========================= */
async function scrapeKalendar() {
  const url = `${BASE}/kalendar-akci/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const items = [];

  $(".event.readable_item").each((_, el) => {
    const title = cleanText($(el).find("h3.title").text());
    const href = $(el).find("h3.title a").attr("href");
    const date = cleanText($(el).find(".publication_date").text());
    const perex = cleanText($(el).find(".perex").text());

    if (!title || !href) return;

    items.push({
      title,
      date,
      perex,
      url: stripTrailingPunctuationFromUrl(absUrl(href)),
    });
  });

  return { url, items: items.slice(0, EVENTS_LIMIT) };
}

/* =========================
   FORMATOVÁNÍ
========================= */
function formatList(items) {
  if (!items.length) return "- (nenalezeno)";

  return items
    .map((i) => {
      let out = `- ${i.title}${i.date ? ` (${i.date})` : ""}`;
      if (i.perex) out += `\n  - Popis: ${i.perex}`;
      if (i.url) out += `\n  - Odkaz: ${i.url}`;
      return out;
    })
    .join("\n");
}

/* =========================
   MAIN
========================= */
async function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const homeHtml = await fetchHtml(`${BASE}/`);
  const $home = cheerio.load(homeHtml);
  const notices = extractHomepageNotice($home);

  const aktuality = await scrapeAktuality();
  const rozhlas = await scrapeRozhlas();
  const kalendar = await scrapeKalendar();

  const output = `
OBEC CHOMUTICE – LIVE DATA
Vygenerováno: ${nowISO()}
Zdroj: ${BASE}

⚠️ POZNÁMKA:
- Automaticky generovaný obsah (pravidelný update).
- Při rozporu má přednost soubor 00_CORE (primární ověřené informace).

────────────────────────────────────────────

=== PROVOZNÍ UPOZORNĚNÍ / HOMEPAGE ===
${notices.length ? notices.map((n) => `- ${n}`).join("\n") : "- (nenalezeno)"}

────────────────────────────────────────────

=== AKTUALITY ===
URL: ${aktuality.url}
Počet položek: ${aktuality.items.length}

${formatList(aktuality.items)}

────────────────────────────────────────────

=== HLÁŠENÍ ROZHLASU ===
URL: ${rozhlas.url}
Počet položek: ${rozhlas.items.length}

${formatList(rozhlas.items)}

────────────────────────────────────────────

=== KALENDÁŘ AKCÍ ===
URL: ${kalendar.url}
Počet položek: ${kalendar.items.length}

${formatList(kalendar.items)}
`.trim();

  fs.writeFileSync(OUT_PATH, output, "utf8");
  console.log("✅ LIVE data ulozena:", OUT_PATH);
}

main().catch((err) => {
  console.error("❌ ERROR:", err.message);
  process.exit(1);
});