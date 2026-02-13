const fileInput = document.getElementById("sdfFile");
const dropZone = document.getElementById("dropZone");
const fallbackCheckbox = document.getElementById("fallbackWithoutSmiles");
const parseBtn = document.getElementById("parseBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const previewHead = document.querySelector("#previewTable thead");
const previewBody = document.querySelector("#previewTable tbody");
const debugEl = document.getElementById("debugOutput");
const OCL_CDN_URLS = [
  "./vendor/openchemlib.js",
  "https://cdn.jsdelivr.net/npm/openchemlib@9.19.0/dist/openchemlib.js",
  "https://unpkg.com/openchemlib@9.19.0/dist/openchemlib.js"
];
let smilesEngineSource = "not_loaded";
let smilesEngineError = "";

let currentFile = null;
let parsedRows = [];
let parsedColumns = [];

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0] || null;
  setCurrentFile(file);
});

setupDropZone();

parseBtn.addEventListener("click", async () => {
  if (!currentFile) {
    setStatus("Select or drop an SDF file first.", true);
    return;
  }

  const allowFallback = fallbackCheckbox.checked;
  let hasSmilesEngine = hasOclGlobal();

  if (!hasSmilesEngine) {
    setStatus("Loading SMILES engine...");
    hasSmilesEngine = await ensureSmilesEngine();
  }

  if (!hasSmilesEngine && !allowFallback) {
    setStatus("SMILES engine unavailable. Enable fallback checkbox to export metadata-only CSV.", true);
    return;
  }

  setStatus("Parsing file...");
  downloadBtn.disabled = true;

  try {
    const { text, wasGzip } = await readSdfText(currentFile);
    const debug = buildDebugInfo(text, currentFile.name, hasSmilesEngine);
    debugEl.textContent = `${debug.message}\nGzip input: ${wasGzip ? "yes" : "no"}`;

    const records = parseSdf(text);
    if (records.length === 0) {
      setStatus(`No valid molecule records found. Detected ${debug.blockCount} SDF block(s).`, true);
      renderPreview([], []);
      return;
    }

    const tagSet = new Set();
    for (const rec of records) {
      for (const key of Object.keys(rec.tags)) tagSet.add(key);
    }

    const tagColumns = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    const columns = ["RecordIndex", "MoleculeName", "SMILES", "SMILES_Status", ...tagColumns];
    const errorCounts = new Map();

    const rows = records.map((rec, idx) => {
      const smilesResult = molfileToSmiles(rec.molblock, hasSmilesEngine);
      if (!smilesResult.smiles && smilesResult.error) {
        errorCounts.set(smilesResult.error, (errorCounts.get(smilesResult.error) || 0) + 1);
      }
      const row = {
        RecordIndex: idx + 1,
        MoleculeName: rec.name,
        SMILES: smilesResult.smiles,
        SMILES_Status: smilesResult.status
      };
      for (const tag of tagColumns) row[tag] = rec.tags[tag] ?? "";
      return row;
    });

    parsedRows = rows;
    parsedColumns = columns;
    renderPreview(rows, columns);

    const smilesCount = rows.filter((r) => r.SMILES).length;
    const failedCount = rows.length - smilesCount;
    const summary = summarizeErrorCounts(errorCounts);
    if (summary) {
      debugEl.textContent += `\n\nTop SMILES failures:\n${summary}`;
    }

    if (!hasSmilesEngine) {
      setStatus(`Detected ${debug.blockCount} block(s), parsed ${rows.length} record(s). Exported without SMILES (fallback mode).`);
    } else {
      setStatus(`Detected ${debug.blockCount} block(s), parsed ${rows.length} record(s). SMILES generated: ${smilesCount}. Failed: ${failedCount}.`);
    }

    downloadBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`Parse failed: ${err.message}`, true);
    renderPreview([], []);
  }
});

downloadBtn.addEventListener("click", () => {
  if (!parsedRows.length) return;

  const csv = buildCsv(parsedRows, parsedColumns);
  const fileBase = (currentFile?.name || "output").replace(/\.(sdf|sd)(\.gz)?$/i, "").replace(/\.gz$/i, "");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileBase}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
});

function setupDropZone() {
  const onDragState = (on) => {
    dropZone.classList.toggle("dragOver", on);
  };

  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      onDragState(true);
    });
  });

  ["dragleave", "dragend"].forEach((evt) => {
    dropZone.addEventListener(evt, () => onDragState(false));
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    onDragState(false);

    const file = e.dataTransfer?.files?.[0] || null;
    if (!file) return;
    setCurrentFile(file);
  });
}

function setCurrentFile(file) {
  currentFile = file;
  parsedRows = [];
  parsedColumns = [];
  downloadBtn.disabled = true;
  renderPreview([], []);

  if (!file) {
    setStatus("No file selected.");
    dropZone.textContent = "Drag and drop an SDF file here";
    debugEl.textContent = "No file parsed yet.";
    return;
  }

  const fileMb = (file.size / (1024 * 1024)).toFixed(2);
  setStatus(`Selected: ${file.name} (${fileMb} MB).`);
  dropZone.textContent = `Ready: ${file.name}`;
  debugEl.textContent = "File selected. Click Parse to populate debug details.";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b42318" : "";
}

async function readSdfText(file) {
  const isGzipByName = /\.sdf\.gz$|\.sd\.gz$|\.gz$/i.test(file.name || "");
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzipByMagic = magic.length === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
  const isGzip = isGzipByName || isGzipByMagic;

  if (!isGzip) {
    return { text: await file.text(), wasGzip: false };
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser does not support gzip decompression (DecompressionStream).");
  }

  const ds = new DecompressionStream("gzip");
  const decompressedStream = file.stream().pipeThrough(ds);
  const text = await new Response(decompressedStream).text();
  return { text, wasGzip: true };
}

function hasOclGlobal() {
  return Boolean(window.OCL && window.OCL.Molecule);
}

function attachOclGlobal(mod) {
  const candidate = mod?.default || mod?.OCL || mod;
  if (candidate && candidate.Molecule) {
    window.OCL = candidate;
    return true;
  }
  return false;
}

async function ensureSmilesEngine() {
  if (hasOclGlobal()) {
    smilesEngineSource = "existing_global";
    return true;
  }

  for (const url of OCL_CDN_URLS) {
    try {
      const mod = await import(url);
      if (attachOclGlobal(mod)) {
        smilesEngineSource = url;
        smilesEngineError = "";
        return true;
      }
    } catch (err) {
      smilesEngineError = err?.message || String(err);
    }
  }
  smilesEngineSource = "load_failed";
  return false;
}

function parseSdf(input) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = splitSdfBlocks(normalized);
  const out = [];

  for (const chunkRaw of chunks) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;

    const lines = chunk.split("\n");
    let mEndIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^M\s+END$/i.test(lines[i].trim())) {
        mEndIndex = i;
        break;
      }
    }
    if (mEndIndex < 0) continue;

    const molblockLines = lines.slice(0, mEndIndex + 1);
    const molblock = molblockLines.join("\n") + "\n";
    const name = (molblockLines[0] || "").trim();
    const dataLines = lines.slice(mEndIndex + 1);
    const tags = parseSdTags(dataLines);

    out.push({ name, molblock, tags });
  }

  return out;
}

function splitSdfBlocks(normalized) {
  const lines = normalized.split("\n");
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (line.trim() === "$$$$") {
      const chunk = current.join("\n").trim();
      if (chunk) blocks.push(chunk);
      current = [];
      continue;
    }
    current.push(line);
  }

  const tail = current.join("\n").trim();
  if (tail) blocks.push(tail);
  return blocks;
}

function buildDebugInfo(text, fileName, hasSmilesEngine) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = splitSdfBlocks(normalized);
  const mEndCount = (normalized.match(/^M\s+END\s*$/gim) || []).length;
  const delimiterCount = (normalized.match(/^\$\$\$\$\s*$/gm) || []).length;
  const headLines = normalized.split("\n").slice(0, 30).join("\n");

  return {
    blockCount: blocks.length,
    message:
`File: ${fileName}
Bytes: ${text.length}
Delimiter lines ($$$$): ${delimiterCount}
Blocks detected: ${blocks.length}
Lines matching M END: ${mEndCount}
SMILES engine ready: ${hasSmilesEngine ? "yes" : "no"}
SMILES engine source: ${smilesEngineSource}
SMILES load error: ${smilesEngineError || "none"}

First 30 lines:
${headLines}`
  };
}

function parseSdTags(lines) {
  const tags = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^>\s*<([^>]+)>/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1].trim();
    i++;

    const valueLines = [];
    while (i < lines.length) {
      const v = lines[i];
      if (v.startsWith(">")) break;
      if (v.trim() === "") {
        i++;
        break;
      }
      valueLines.push(v);
      i++;
    }

    const value = valueLines.join("\n").trim();
    if (value) tags[key] = value;
  }

  return tags;
}

function molfileToSmiles(molfile, hasSmilesEngine) {
  if (!hasSmilesEngine) {
    return { smiles: "", status: "ENGINE_UNAVAILABLE", error: "ENGINE_UNAVAILABLE" };
  }

  let mol = null;
  let parseError = "";

  try {
    mol = OCL.Molecule.fromMolfile(molfile);
  } catch (err) {
    parseError = shortError(err);
  }

  if (!mol) {
    try {
      // SDFileParser can be more tolerant on some molfile edge-cases.
      const parser = new OCL.SDFileParser(`${molfile}\n$$$$\n`, null);
      if (parser.next()) {
        mol = parser.getMolecule();
      }
    } catch (err) {
      parseError = parseError || shortError(err);
    }
  }

  if (!mol) {
    return { smiles: "", status: "PARSE_FAILED", error: parseError || "PARSE_FAILED" };
  }

  try {
    return { smiles: mol.toSmiles(), status: "OK", error: "" };
  } catch (err) {
    const toSmilesError = shortError(err);
    try {
      const iso = mol.toIsomericSmiles();
      if (iso) return { smiles: iso, status: "ISOMERIC_OK", error: "" };
    } catch (_) {}
    try {
      const kek = mol.toIsomericSmiles({ kekulizedOutput: true });
      if (kek) return { smiles: kek, status: "KEKULIZED_OK", error: "" };
    } catch (_) {}
    try {
      // SMARTS fallback captures structures that are not representable as strict SMILES.
      const smarts = mol.toIsomericSmiles({ createSmarts: true });
      if (smarts) return { smiles: smarts, status: "SMARTS_FALLBACK", error: "" };
    } catch (_) {}
    return { smiles: "", status: "SMILES_FAILED", error: toSmilesError || "SMILES_FAILED" };
  }
}

function shortError(err) {
  const msg = err?.message || String(err || "");
  return msg.replace(/\s+/g, " ").trim().slice(0, 120) || "unknown_error";
}

function summarizeErrorCounts(errorCounts) {
  if (!errorCounts.size) return "";
  const top = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  return top.map(([msg, count]) => `${count}x - ${msg}`).join("\n");
}

function buildCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows
    .map((row) => columns.map((c) => csvEscape(row[c] ?? "")).join(","))
    .join("\n");
  return `${header}\n${body}\n`;
}

function csvEscape(value) {
  const str = String(value);
  if (/[,"\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function renderPreview(rows, columns) {
  previewHead.innerHTML = "";
  previewBody.innerHTML = "";

  if (!rows.length || !columns.length) return;

  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  }
  previewHead.appendChild(headRow);

  const maxRows = Math.min(rows.length, 100);
  for (let i = 0; i < maxRows; i++) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      td.textContent = rows[i][col] ?? "";
      tr.appendChild(td);
    }
    previewBody.appendChild(tr);
  }
}
