// scripts/upload-live-to-openai.mjs
// Node 18+
//
// ENV:
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=vs_...
// Optional:
//   ASSISTANT_ID=asst_...
//   LIVE_FILE_PATH=... (default local: knowledge/10_LIVE_obec_chomutice.txt)
//   CLEANUP_OLD=1
//   OPENAI_BASE_URL=https://api.openai.com
//
// This script is Netlify-safe:
// - if LIVE file doesn't exist, it generates it by running scripts/live_chomutice_scrape.mjs
// - on Netlify/serverless it writes into /tmp

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

const CLEANUP_OLD = cleanEnv(process.env.CLEANUP_OLD) === "1";

// default path people use locally
const DEFAULT_LIVE_REL = "knowledge/10_LIVE_obec_chomutice.txt";

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

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
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

function runNode(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`node ${scriptPath} failed (${code})`))));
  });
}

// Decide where LIVE file should live.
// - If user explicitly set LIVE_FILE_PATH, respect it.
// - Otherwise: local dev -> ./knowledge/...
// - Netlify/serverless -> /tmp/knowledge/...
function resolveLivePath() {
  const explicit = cleanEnv(process.env.LIVE_FILE_PATH);
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);

  const isServerless = !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (isServerless) {
    const tmpDir = path.join(os.tmpdir(), "knowledge");
    return path.join(tmpDir, "10_LIVE_obec_chomutice.txt");
  }

  return path.resolve(process.cwd(), DEFAULT_LIVE_REL);
}

// Ensures LIVE file exists. If not, generate it via your scrape script.
async function ensureLiveFileExists(liveAbsPath) {
  if (fs.existsSync(liveAbsPath)) return;

  const dir = path.dirname(liveAbsPath);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`ℹ️ LIVE file not found, generating: ${liveAbsPath}`);

  // We want the scrape script to write into the same folder.
  // If your scrape script supports env var output dir, use it.
  // If not, we still can run it by temporarily changing CWD strategy would be risky,
  // so we pass LIVE_OUT_DIR which you can optionally read in scrape script later.
  const liveOutDir = dir;

  // IMPORTANT:
  // Your current scrape script likely writes to "knowledge/10_LIVE_obec_chomutice.txt" relative to repo.
  // In Netlify runtime that folder is not writable.
  // So we MUST make scrape script write into /tmp/knowledge.
  //
  // If your scrape script already reads env LIVE_FILE_PATH or OUT_DIR, it will work immediately.
  // If it doesn't, tell me and I'll patch that script too (small change).
  await runNode(path.resolve(process.cwd(), "scripts/live_chomutice_scrape.mjs"), {
    LIVE_FILE_PATH: liveAbsPath,
    LIVE_OUT_DIR: liveOutDir,
    OUT_DIR: liveOutDir,
    KNOWLEDGE_DIR: liveOutDir,
  });

  if (!fs.existsSync(liveAbsPath)) {
    throw new Error(`LIVE file still missing after scrape: ${liveAbsPath} (scrape script must write to LIVE_FILE_PATH/OUT_DIR)`);
  }
}

async function uploadFileToOpenAI(absPath) {
  if (!fs.existsSync(absPath)) throw new Error(`LIVE file not found: ${absPath}`);

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

  await api(`/v1/assistants/${assistantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    }),
  });

  console.log("✅ Assistant updated to use this vector store.");
}

async function listVectorStoreFiles(vectorStoreId, limit = 100) {
  const out = await api(`/v1/vector_stores/${vectorStoreId}/files?limit=${limit}`);
  return out?.data || [];
}

async function deleteVectorStoreFile(vectorStoreId, vectorStoreFileId) {
  await api(`/v1/vector_stores/${vectorStoreId}/files/${vectorStoreFileId}`, { method: "DELETE" });
}

async function cleanupOldLiveFiles(vectorStoreId, liveFilename) {
  console.log("🧹 CLEANUP_OLD=1 → hledám staré LIVE soubory ve vector store...");
  const files = await listVectorStoreFiles(vectorStoreId, 100);

  const toDelete = [];
  for (const f of files) {
    const fileId = f.file_id;
    if (!fileId) continue;

    let meta;
    try {
      meta = await api(`/v1/files/${fileId}`);
    } catch {
      continue;
    }

    const name = meta?.filename || "";
    const isLive =
      name === liveFilename ||
      name.toLowerCase().includes("live") ||
      name.toLowerCase().includes("10_live_obec_chomutice");

    if (isLive) toDelete.push({ vsFileId: f.id, fileId, filename: name });
  }

  for (const d of toDelete) {
    console.log(`🗑️  Mazání: ${d.filename} (vs_file=${d.vsFileId}, file=${d.fileId})`);
    await deleteVectorStoreFile(vectorStoreId, d.vsFileId);
  }

  console.log(`✅ Cleanup hotov (smazáno: ${toDelete.length})`);
}

async function attachFileToVectorStore(vectorStoreId, fileId) {
  const batch = await api(`/v1/vector_stores/${vectorStoreId}/file_batches`, {
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

    const check = await api(`/v1/vector_stores/${vectorStoreId}/file_batches/${batch.id}`);
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

  // ⭐ Ensures file exists by generating it if missing
  await ensureLiveFileExists(liveAbsPath);

  if (CLEANUP_OLD) {
    await cleanupOldLiveFiles(VECTOR_STORE_ID, liveFilename);
  }

  const { fileId } = await uploadFileToOpenAI(liveAbsPath);
  await attachFileToVectorStore(VECTOR_STORE_ID, fileId);

  const filesNow = await listVectorStoreFiles(VECTOR_STORE_ID, 50);
  console.log(`✅ Vector store now has ${filesNow.length} files (showing first 5 ids):`);
  console.log(filesNow.slice(0, 5).map((x) => `${x.id} -> file_id=${x.file_id}`).join("\n"));

  console.log("🎉 HOTOVO: LIVE data jsou ve vector store a asistent je může použít.");
}

main().catch((err) => {
  console.error("❌ ERROR:", err?.message || err);
  process.exit(1);
});