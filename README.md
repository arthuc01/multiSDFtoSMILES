# multiSDFtoSMILES

Browser-based converter for multi-molecule SDF files to CSV, including:
- `SMILES` generated from each molecule structure
- all SD data fields/tags (for example `binding_logP`, scores, IDs, etc.)

## Why not Open Babel JS?
There is no actively maintained, drop-in Open Babel browser build that reliably supports this workflow (multi-record parsing + metadata export) out of the box for GitHub Pages.

This tool uses:
- custom SDF parser in JavaScript for robust multi-record + SD tag extraction
- [OpenChemLib JS](https://github.com/Actelion/openchemlib-js) in the browser to convert mol blocks to SMILES
- a vendored local OpenChemLib module at `vendor/openchemlib.js` with `vendor/resources.json`
- dynamic module loading with CDN fallback in app logic

## Usage
1. Open the app (local file or GitHub Pages).
2. Choose an `.sdf`, `.sd`, `.sdf.gz`, or `.sd.gz` file, or drag/drop it onto the drop area.
3. Optional: enable fallback checkbox to export even if SMILES engine is unavailable.
4. Click **Parse**.
5. Click **Download CSV**.

The exported CSV contains columns:
- `RecordIndex`
- `MoleculeName`
- `SMILES`
- `SMILES_Status` (`OK`, `PARSE_FAILED`, `ENGINE_UNAVAILABLE`)
- one column per discovered SD tag across the full file

## GitHub Pages
This repository is static-site compatible:
- `index.html`
- `app.js`
- `styles.css`
- `vendor/openchemlib.js`
- `vendor/resources.json`

To publish:
1. Push to GitHub.
2. In repo settings, go to **Pages**.
3. Set source to your default branch and root folder (`/`).
4. Save; GitHub will provide the site URL.

## Notes
- Parsing and conversion run fully client-side (no server upload).
- In fallback mode, metadata exports even if SMILES cannot be computed.
- Gzipped inputs (`.sdf.gz`) are supported in browsers with `DecompressionStream`.
- Extremely large SDF files may take time in browser memory.
