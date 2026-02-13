const fileInput = document.getElementById("sdfFile");
const dropZone = document.getElementById("dropZone");
const fallbackCheckbox = document.getElementById("fallbackWithoutSmiles");
const parseBtn = document.getElementById("parseBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const previewHead = document.querySelector("#previewTable thead");
const previewBody = document.querySelector("#previewTable tbody");

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
  const hasSmilesEngine = Boolean(window.OCL);

  if (!hasSmilesEngine && !allowFallback) {
    setStatus("SMILES engine unavailable. Enable fallback checkbox to export metadata-only CSV.", true);
    return;
  }

  setStatus("Parsing file...");
  downloadBtn.disabled = true;

  try {
    const text = await currentFile.text();
    const records = parseSdf(text);
    if (records.length === 0) {
      setStatus("No valid molecule records found.", true);
      renderPreview([], []);
      return;
    }

    const tagSet = new Set();
    for (const rec of records) {
      for (const key of Object.keys(rec.tags)) tagSet.add(key);
    }

    const tagColumns = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    const columns = ["RecordIndex", "MoleculeName", "SMILES", "SMILES_Status", ...tagColumns];

    const rows = records.map((rec, idx) => {
      const smilesResult = molfileToSmiles(rec.molblock, hasSmilesEngine);
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

    if (!hasSmilesEngine) {
      setStatus(`Parsed ${rows.length} record(s). Exported without SMILES (fallback mode).`);
    } else {
      setStatus(`Parsed ${rows.length} record(s). SMILES generated: ${smilesCount}. Failed: ${failedCount}.`);
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
  const fileBase = (currentFile?.name || "output").replace(/\.[^.]+$/, "");
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
    return;
  }

  const fileMb = (file.size / (1024 * 1024)).toFixed(2);
  setStatus(`Selected: ${file.name} (${fileMb} MB).`);
  dropZone.textContent = `Ready: ${file.name}`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b42318" : "";
}

function parseSdf(input) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = normalized.split(/\n\$\$\$\$\s*(?:\n|$)/g);
  const out = [];

  for (const chunkRaw of chunks) {
    const chunk = chunkRaw.trim();
    if (!chunk) continue;

    const lines = chunk.split("\n");
    let mEndIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "M END") {
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
    return { smiles: "", status: "ENGINE_UNAVAILABLE" };
  }

  try {
    const mol = OCL.Molecule.fromMolfile(molfile);
    return { smiles: mol.toSmiles(), status: "OK" };
  } catch (err) {
    return { smiles: "", status: "PARSE_FAILED" };
  }
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