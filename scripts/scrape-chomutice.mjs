import fs from "fs";

async function run() {
  const now = new Date().toISOString();

  const content = `
Znalostní báze – Obec Chomutice
Aktualizováno: ${now}

Tento soubor byl vytvořen automaticky.
Zatím neobsahuje žádná data z webu obce.
`;

  fs.writeFileSync(
    "knowledge/obec-chomutice-live.txt",
    content.trim(),
    "utf8"
  );

  console.log("✅ Knowledge base vytvořena");
}

run();
