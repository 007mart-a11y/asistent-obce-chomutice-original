// scripts/upload-live-to-openai.mjs
// Node 18+
//
// ENV:
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=vs_...
// Optional:
//   ASSISTANT_ID=asst_...
//   CLEANUP_OLD=1 (default ON; vypnout: CLEANUP_OLD=0)
//   OPENAI_BASE_URL=https://api.openai.com
//
// Netlify-safe:
// - generuje LIVE do /tmp/knowledge/.. (serverless) nebo do public/knowledge (lokálně)
// - před uploadem smaže staré LIVE soubory z vector store

import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "node:child_process";

const cleanEnv = (v) =>
  (v || "")
    .trim()
    .replace(/^[\s"'“”]+/, "")
    .replace(/[\s"'“”]+$/, "");

const OPENAI_API_KEY = cleanEnv(process.env.OPENAI_API_KEY);
const VECTOR_STORE_ID = cleanEnv(process.env.VECTOR_STORE_ID);
const ASSISTANT_ID = cleanEnv(process.env.ASSISTANT_ID);
const OPENAI_BASE_URL = cleanEnv(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");

// default: cleanup ON (vypnout jen CLEANUP_OLD=0)
const CLEANUP_OLD = cleanEnv(process.env.CLEANUP_OLD) !== "0";
console.log("CLEANUP_OLD:", CLEANUP_OLD ? "ON" : "OFF");

// Assistants v2 header (nutné pro vector stores/assistants endpoints)
const BETA_HEADERS = { "OpenAI-Beta": "assistants=v2" };

if (!OPENAI_API_KEY) {
  console.error("❌ Missing env OPENAI_API_KEY");
  process.exit(1);
}
if (!VECTOR_STORE_ID) {
  console.error("❌ Missing env VECTOR_STORE_ID (vs_...)");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(s) {
  return s.replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/[–]/g, "-");
}

async function apiV2(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...BETA_HEADERS,
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${pathname} failed: ${msg}`);
  }
  return json ?? {};
}

// /v1/files endpoint (bez beta header)
async function apiFiles(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...headers,
    },
    body,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${pathname} failed: ${msg}`);
  }
  return json ?? {};
}

function runNode(scriptAbsPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [scriptAbsPath], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`node ${scriptAbsPath} failed (${code})`))
    );
  });
}

function isServerless() {
  return !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

// kde má vzniknout LIVE soubor
function resolveLivePath() {
  const explicit = cleanEnv(process.env.LIVE_FILE_PATH);
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);

  if (isServerless()) {
    const dir = path.join(os.tmpdir(), "knowledge");
    return path.join(dir, "10_LIVE_obec_chomutice.txt");
  }

  return path.join(process.cwd(), "public", "knowledge", "10_LIVE_obec_chomutice.txt");
}

async function ensureLiveFileExists(liveAbsPath) {
  if (fs.existsSync(liveAbsPath)) return;

  fs.mkdirSync(path.dirname(liveAbsPath), { recursive: true });
  console.log(`ℹ️ LIVE file not found, generating: ${liveAbsPath}`);

  const scrapeAbs = path.resolve(process.cwd(), "scripts/live_chomutice_scrape.mjs");

  // ✅ řekneme scraperu přes env kam má zapisovat
  await runNode(scrapeAbs, { LIVE_FILE_PATH: liveAbsPath });

  if (!fs.existsSync(liveAbsPath)) {
    throw new Error(`LIVE file still missing after scrape: ${liveAbsPath}`);
  }
}

async function uploadFileToOpenAI(absPath) {
  let content = fs.readFileSync(absPath, "utf8");
  content = normalizeText(content);
  fs.writeFileSync(absPath, content, "utf8");

  const buf = fs.readFileSync(absPath);
  const filename = path.basename(absPath);

  const fd = new FormData();
  fd.append("purpose", "assistants");
  fd.append("file", new Blob([buf]), filename);

  const res = await fetch(`${OPENAI_BASE_URL}/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`Upload failed: ${msg}`);
  }

  if (!json?.id) throw new Error("Upload succeeded but missing file id.");
  console.log(`✅ Uploaded file: ${filename} -> file_id=${json.id}`);
  return { fileId: json.id, filename };
}

async function ensureAssistantUsesVectorStore(assistantId, vectorStoreId) {
  if (!assistantId) return;
  console.log(`🔗 Updating assistant tool_resources: ${assistantId} -> vector_store_ids=[${vectorStoreId}]`);

  await apiV2(`/v1/assistants/${assistantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    }),
  });

  console.log("✅ Assistant updated to use this vector store.");
}

async function listVectorStoreFiles(vectorStoreId, limit = 100) {
  const out = await apiV2(`/v1/vector_stores/${vectorStoreId}/files?limit=${limit}`);
  return out?.data || [];
}

// ✅ robustní: některé odpovědi mají file_id, některé jen id, někde je to v f.file.id
function pickFileId(f) {
  return f?.file_id || f?.file?.id || f?.id || null;
}

async function pickFilename(f) {
  if (f?.filename) return f.filename;
  if (f?.file?.filename) return f.file.filename;

  const fileId = pickFileId(f);
  if (!fileId) return "";

  try {
    const meta = await apiFiles(`/v1/files/${fileId}`);
    return meta?.filename || "";
  } catch {
    return "";
  }
}

async function deleteVectorStoreFile(vectorStoreId, idMaybe) {
  // Nejčastěji funguje delete přes /vector_stores/{vs}/files/{id}
  await apiV2(`/v1/vector_stores/${vectorStoreId}/files/${idMaybe}`, { method: "DELETE" });
}

async function cleanupOldLiveFiles(vectorStoreId, liveFilename) {
  console.log("🧹 CLEANUP_OLD=1 → hledám staré LIVE soubory ve vector store...");
  const files = await listVectorStoreFiles(vectorStoreId, 100);

  const toDelete = [];
  for (const f of files) {
    const name = (await pickFilename(f)) || "";
    const lower = name.toLowerCase();

    // ✅ jen LIVE soubory
    const isLive =
      lower === liveFilename.toLowerCase() ||
      lower.includes("10_live_obec_chomutice") ||
      lower.includes("live_obec_chomutice") ||
      lower.includes("10_live");

    if (!isLive) continue;

    // id pro delete – v praxi to bývá to, co je v `f.id` (a někdy je to přímo file-...)
    const deleteId = f?.id || pickFileId(f);
    if (!deleteId) continue;

    toDelete.push({ deleteId, filename: name || "(unknown)" });
  }

  for (const d of toDelete) {
    console.log(`🗑️  Mazání z vector store: ${d.filename} (id=${d.deleteId})`);
    try {
      await deleteVectorStoreFile(vectorStoreId, d.deleteId);
    } catch (e) {
      // fallback: když by delete chtěl místo f.id něco jiného
      console.log(`⚠️  Delete fallback for id=${d.deleteId}: ${e?.message || e}`);
    }
  }

  console.log(`✅ Cleanup hotov (smazáno: ${toDelete.length})`);
}

async function attachFileToVectorStore(vectorStoreId, fileId) {
  const batch = await apiV2(`/v1/vector_stores/${vectorStoreId}/file_batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids: [fileId] }),
  });

  if (!batch?.id) throw new Error("Missing file_batch id.");
  console.log(`📦 Created file_batch: ${batch.id}`);

  const timeoutMs = 180_000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for vector store indexing.");

    const check = await apiV2(`/v1/vector_stores/${vectorStoreId}/file_batches/${batch.id}`);
    const status = check?.status || "unknown";
    const counts = check?.file_counts;

    console.log(`⏳ Indexing status: ${status}${counts ? ` | ${JSON.stringify(counts)}` : ""}`);

    if (status === "completed") return;
    if (status === "failed" || status === "cancelled") throw new Error(`Indexing failed: ${status}`);

    await sleep(2000);
  }
}

async function main() {
  const liveAbsPath = resolveLivePath();
  const liveFilename = path.basename(liveAbsPath);

  console.log("—— Upload LIVE → OpenAI Vector Store ——");
  console.log("LIVE_FILE_PATH (resolved):", liveAbsPath);
  console.log("VECTOR_STORE_ID:", VECTOR_STORE_ID);
  if (ASSISTANT_ID) console.log("ASSISTANT_ID:", ASSISTANT_ID);

  await ensureAssistantUsesVectorStore(ASSISTANT_ID, VECTOR_STORE_ID);

  // ✅ vytvoří LIVE když neexistuje (na Netlify do /tmp)
  await ensureLiveFileExists(liveAbsPath);

  // ✅ smaže staré LIVE z vector store (teď už fakt)
  if (CLEANUP_OLD) {
    await cleanupOldLiveFiles(VECTOR_STORE_ID, liveFilename);
  }

  // ✅ upload + attach
  const { fileId } = await uploadFileToOpenAI(liveAbsPath);
  await attachFileToVectorStore(VECTOR_STORE_ID, fileId);

  const filesNow = await listVectorStoreFiles(VECTOR_STORE_ID, 50);
  console.log(`✅ Vector store now has ${filesNow.length} files.`);
  console.log("🎉 HOTOVO: LIVE data jsou ve vector store a asistent je může použít.");
}

main().catch((err) => {
  console.error("❌ ERROR:", err?.message || err);
  process.exit(1);
});