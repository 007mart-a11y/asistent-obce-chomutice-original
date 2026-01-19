// scripts/upload-live-to-openai.mjs
// Node 18+
// ENV:
//   OPENAI_API_KEY=...
//   VECTOR_STORE_ID=vs_...
// Optional:
//   LIVE_FILE_PATH=knowledge/10_LIVE_obec_chomutice.txt
//   CLEANUP_OLD=1   (smaže staré LIVE soubory ve vector store)
//   OPENAI_BASE_URL=https://api.openai.com  (nech default)

import fs from "fs";
import path from "path";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const LIVE_FILE_PATH = process.env.LIVE_FILE_PATH || "knowledge/10_LIVE_obec_chomutice.txt";
const CLEANUP_OLD = process.env.CLEANUP_OLD === "1";

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

async function api(pathname, { method = "GET", headers = {}, body } = {}) {
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
  } catch {
    // not json
  }

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${pathname} failed: ${msg}`);
  }
  return json ?? {};
}

async function uploadFileToOpenAI(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`LIVE file not found: ${abs}`);
  }

  const buf = fs.readFileSync(abs);
  const filename = path.basename(abs);

  const fd = new FormData();
  fd.append("purpose", "assistants");
  fd.append("file", new Blob([buf]), filename);

  const res = await fetch(`${OPENAI_BASE_URL}/v1/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      // content-type necháváme na fetch/FormData
    },
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

async function listVectorStoreFiles(vectorStoreId, limit = 100) {
  // GET /v1/vector_stores/{id}/files?limit=...
  const out = await api(`/v1/vector_stores/${vectorStoreId}/files?limit=${limit}`);
  return out?.data || [];
}

async function deleteVectorStoreFile(vectorStoreId, vectorStoreFileId) {
  // DELETE /v1/vector_stores/{id}/files/{vector_store_file_id}
  await api(`/v1/vector_stores/${vectorStoreId}/files/${vectorStoreFileId}`, { method: "DELETE" });
}

async function cleanupOldLiveFiles(vectorStoreId, liveFilename) {
  console.log("🧹 CLEANUP_OLD=1 → hledám staré LIVE soubory ve vector store...");
  const files = await listVectorStoreFiles(vectorStoreId, 100);

  // Vector-store file objekt má typicky:
  // { id: "vsf_...", status, file_id, ... }
  // Název souboru se získává přes /v1/files/{file_id}
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
    // smažeme všechny soubory, které vypadají jako LIVE (včetně starých názvů)
    const isLive =
      name === liveFilename ||
      name.toLowerCase().includes("live") ||
      name.toLowerCase().includes("10_live_obec_chomutice");

    if (isLive) {
      toDelete.push({ vsFileId: f.id, fileId, filename: name });
    }
  }

  // Necháme max 0 starých LIVE (tj. smažeme všechny)
  for (const d of toDelete) {
    console.log(`🗑️  Mazání: ${d.filename} (vs_file=${d.vsFileId}, file=${d.fileId})`);
    await deleteVectorStoreFile(vectorStoreId, d.vsFileId);
    // Samotný file v /v1/files zůstane — je to OK. (Můžeme mazat i file, ale není nutné.)
  }

  console.log(`✅ Cleanup hotov (smazáno: ${toDelete.length})`);
}

async function attachFileToVectorStore(vectorStoreId, fileId) {
  // Nejčistší je udělat file batch:
  // POST /v1/vector_stores/{id}/file_batches { file_ids: [...] }
  const batch = await api(`/v1/vector_stores/${vectorStoreId}/file_batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_ids: [fileId] }),
  });

  if (!batch?.id) throw new Error("Missing file_batch id.");
  console.log(`📦 Created file_batch: ${batch.id}`);

  // Poll batch status
  const timeoutMs = 120_000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for vector store indexing (file_batch).");
    }

    const check = await api(`/v1/vector_stores/${vectorStoreId}/file_batches/${batch.id}`);
    const status = check?.status || "unknown";
    const counts = check?.file_counts;

    console.log(`⏳ Indexing status: ${status}${counts ? ` | counts=${JSON.stringify(counts)}` : ""}`);

    if (status === "completed") {
      console.log("✅ Vector store indexing completed.");
      return;
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Vector store indexing failed: status=${status}`);
    }

    await sleep(2000);
  }
}

async function main() {
  const liveFilename = path.basename(LIVE_FILE_PATH);

  console.log("—— Upload LIVE → OpenAI Vector Store ——");
  console.log("LIVE_FILE_PATH:", LIVE_FILE_PATH);
  console.log("VECTOR_STORE_ID:", VECTOR_STORE_ID);

  if (CLEANUP_OLD) {
    await cleanupOldLiveFiles(VECTOR_STORE_ID, liveFilename);
  }

  const { fileId } = await uploadFileToOpenAI(LIVE_FILE_PATH);
  await attachFileToVectorStore(VECTOR_STORE_ID, fileId);

  console.log("🎉 HOTOVO: LIVE data jsou ve vector store a asistent je může použít.");
}

main().catch((err) => {
  console.error("❌ ERROR:", err?.message || err);
  process.exit(1);
});