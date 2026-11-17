# Cricexec LinkedIn Profile Batch Extractor

A single-page JavaScript application with a Node.js backend for **updating existing** rows in your NocoDB table. MHTML/HTML parsing and CSV export happen in the browser. The backend receives extracted text fields only and uses a NocoDB token stored in Render environment variables.

## Files

- `public/index.html` — extractor and interface
- `server.js` — NocoDB matching and PATCH-only updates
- `field-mapping.json` — 63 exact source-to-NocoDB field mappings from your spreadsheet
- `package.json` — start/test scripts (no third-party packages)
- `.env.example` — environment variable names only; **never commit a real token**

## Deploy using private GitHub + Render Free

1. Create a **private GitHub repository**. Upload the contents of this folder to the repository root (not the ZIP file itself).
2. In Render: **New > Web Service** > Connect your private GitHub repository.
3. Configure:
   - Language/runtime: **Node**
   - Build command: `npm install` (no external dependencies are used)
   - Start command: `npm start`
   - Instance type: **Free**
4. In Render **Environment**, set:
   - `NOCODB_API_TOKEN` = your NocoDB API token (keep private)
   - `NOCODB_URL` = `https://cricexec-nocodb-prod.onrender.com`
   - `NOCODB_TABLE_ID` = `mlb0mtz902gqwg9`
5. Deploy and open the Render `.onrender.com` URL.
6. Select a few saved LinkedIn MHTML files, click **Extract profiles**, verify names, then **Update NocoDB**. Download the update report.

## Safeguards and matching

- Updates **only** existing rows; does not create rows.
- Primary matching: normalized LinkedIn slug from the MHTML `Snapshot-Content-Location` or saved HTML URL compared with `ProfileURL`.
- Secondary matching: normalized `fullName` to NocoDB's `FullName` when URL doesn't match.
- If both have populated but conflicting URLs, **manual review, no update**.
- Duplicate URL or ambiguous name, **manual review, no update**.
- Unique name-only fallback is updated but marked **Updated · check** in the report.
- `ProfileURL` and `FullName` are **never modified**. The 63 mapped output columns (including `fullName 2`) are distinct from those identifiers.
- Empty extracted values are not submitted, so existing data is kept. All other columns are untouched.
- The server fetches matching records and updates via NocoDB v2 PATCH; each update sends only the row `Id` and nonempty mapped fields.
- NocoDB table columns are checked against mapping before any batch update. The application fails closed if mapped columns or required identifiers are missing.
- Uploads are split into 20-profile requests. Per-server rate limit is 8 update requests per minute per IP. NocoDB matches are read once per request; for large tables, this can increase API traffic.
- Report lists updated, updated-with-review, review, unmatched, and failed records and their row IDs.

## Security notice

This app **does not have login/authentication**, at your request. A private GitHub repository does **not** make the Render website private. Anyone who discovers the website URL can potentially use the NocoDB update endpoint; environment variables protect the *secret itself*, **not the endpoint**. The limited allowed fields, single destination table, origin check and rate limit reduce mistakes but **are not substitutes for authentication**. Use a NocoDB token with the minimum possible permissions; if feasible, add authentication before sharing the URL widely.

## Run locally / tests

Node.js >= 20:

```bash
npm test
npm start
```

Open `http://localhost:3000`.

## Limitations

- Browser-side extraction follows the structure in the supplied Laurie Evans sample. More layouts may require selector adjustments.
- Server uses NocoDB v2 APIs. Confirm that your self-hosted version supports metadata GET, record pagination GET and record PATCH before first actual update.
- Batch requests are not transactional. If a network error occurs, inspect the NocoDB row/report before resubmitting.
- No external live NocoDB write was attempted during development.
