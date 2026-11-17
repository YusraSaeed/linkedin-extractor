
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mapping = require('./field-mapping.json');

const PORT = Number(process.env.PORT || 3000);
const NOCODB_URL = (
  process.env.NOCODB_URL ||
  'https://cricexec-nocodb-prod.onrender.com'
).replace(/\/+$/, '');

const TABLE_ID = process.env.NOCODB_TABLE_ID || 'mlb0mtz902gqwg9';
const TOKEN = process.env.NOCODB_API_TOKEN || '';
const STATIC_FILE = path.join(__dirname, 'public/index.html');

const READ_ONLY = new Set(['ProfileURL', 'FullName']);
const MAX_ROWS = 25000;
const PAGE_SIZE = 100;
const MAX_BATCH = 20;
const MAX_BODY = 1024 * 1024;

const recent = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeProfile(v) {
  try {
    const url = new URL(
      String(v || '').trim().replace(/&amp;/g, '&')
    );

    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';

    const pieces = url.pathname.split('/').filter(Boolean);

    return pieces[0]?.toLowerCase() === 'in' && pieces[1]
      ? decodeURIComponent(pieces[1]).toLowerCase()
      : '';
  } catch {
    return '';
  }
}

function normalizeName(v) {
  return String(v || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim();
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(payload));
}

function fail(reason, status = 'failed', extra = {}) {
  return { status, reason, ...extra };
}

async function nocoRequest(urlPath, method = 'GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(NOCODB_URL + urlPath, {
      method,
      headers: {
        'xc-token': TOKEN,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
      signal: controller.signal
    });

    const raw = await response.text();

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      throw Error(
        `NocoDB HTTP ${response.status}: ${
          typeof parsed === 'string'
            ? parsed.slice(0, 150)
            : JSON.stringify(parsed).slice(0, 150)
        }`
      );
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// Detect the primary key from NocoDB metadata.
// The individuals table uses uppercase "ID".
function getPrimaryKeyColumn(cols) {
  const keys = cols.filter(
    c => c.pk === true || c.pk === 1 || c.pk === '1'
  );

  if (keys.length > 1) {
    throw Error(
      'NocoDB reports multiple primary key fields; ' +
      'composite keys are unsupported. No records updated.'
    );
  }

  const key =
    keys[0] ||
    cols.find(
      c => String(c.title || '').toLowerCase() === 'id'
    );

  if (!key || !key.title) {
    throw Error(
      'Could not identify the NocoDB primary key field. ' +
      'No records updated.'
    );
  }

  return key.title;
}

async function getMetadata() {
  const data = await nocoRequest(
    `/api/v2/meta/tables/${encodeURIComponent(TABLE_ID)}`
  );

  const cols = data.columns || [];
  const titles = new Set(cols.map(c => c.title));

  for (const key of ['ProfileURL', 'FullName']) {
    if (!titles.has(key)) {
      throw Error(
        `Required NocoDB field '${key}' is missing. ` +
        'No records updated.'
      );
    }
  }

  const primaryKey = getPrimaryKeyColumn(cols);

  const writeTypes = new Set([
    'SingleLineText',
    'LongText',
    'URL',
    'Email',
    'PhoneNumber',
    'Number',
    'Decimal',
    'Currency',
    'Percent',
    'SingleSelect'
  ]);

  const permitted = new Set(
    cols
      .filter(
        c =>
          writeTypes.has(c.uidt) &&
          !c.system &&
          !READ_ONLY.has(c.title) &&
          c.title !== primaryKey
      )
      .map(c => c.title)
  );

  const bad = Object.values(mapping).filter(
    target => !permitted.has(target)
  );

  if (bad.length) {
    throw Error(
      `Missing or unsupported mapped columns: ${bad.join(', ')}. ` +
      'No records updated.'
    );
  }

  return { permitted, primaryKey };
}

async function listRows() {
  const all = [];

  for (
    let offset = 0;
    offset < MAX_ROWS;
    offset += PAGE_SIZE
  ) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset)
    });

    const data = await nocoRequest(
      `/api/v2/tables/${encodeURIComponent(TABLE_ID)}/records?${params}`
    );

    if (!Array.isArray(data.list)) {
      throw Error(
        'NocoDB records response did not contain a list. ' +
        'No updates attempted.'
      );
    }

    all.push(...data.list);

    if (data.list.length < PAGE_SIZE) {
      return all;
    }
  }

  throw Error(
    `Safety limit of ${MAX_ROWS} records reached; ` +
    'refusing updates until pagination strategy is configured.'
  );
}

function indexRows(rows) {
  const byUrl = new Map();
  const byName = new Map();

  for (const row of rows) {
    const url = normalizeProfile(row.ProfileURL);
    const name = normalizeName(row.FullName);

    if (url) {
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(row);
    }

    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(row);
    }
  }

  return { byUrl, byName };
}

function matchProfile(profile, index, primaryKey = 'Id') {
  const url = normalizeProfile(profile.profileUrl);
  const name = normalizeName(profile.fullName);

  const urls = url ? index.byUrl.get(url) || [] : [];
  const names = name ? index.byName.get(name) || [] : [];

  if (urls.length > 1) {
    return fail(
      `${urls.length} rows share the profile URL`,
      'review'
    );
  }

  if (urls.length === 1) {
    const row = urls[0];

    if (normalizeName(row.FullName) !== name) {
      return fail(
        `URL matched but FullName differs in NocoDB: ${row.FullName}`,
        'review'
      );
    }

    if (
      names.length === 1 &&
      String(names[0][primaryKey]) !==
        String(row[primaryKey])
    ) {
      return fail(
        'URL and name identify different rows',
        'review'
      );
    }

    return {
      row,
      method: 'ProfileURL',
      review: false
    };
  }

  if (names.length > 1) {
    return fail(
      `${names.length} rows share FullName; ` +
      'cannot safely use name fallback',
      'review'
    );
  }

  if (names.length === 1) {
    const row = names[0];

    const stored = normalizeProfile(row.ProfileURL);

    if (stored && url && stored !== url) {
      return fail(
        'Name matched, but ProfileURL differs; ' +
        'manual review required',
        'review'
      );
    }

    return {
      row,
      method: 'FullName',
      review: true
    };
  }

  return fail(
    'No ProfileURL or FullName match in the NocoDB table',
    'unmatched'
  );
}

function buildChanges(fields, permitted) {
  const payload = {};

  for (const [source, target] of Object.entries(mapping)) {
    if (
      READ_ONLY.has(target) ||
      !permitted.has(target)
    ) {
      continue;
    }

    const value = fields[source];

    if (typeof value === 'string' && value.trim()) {
      payload[target] = value.trim();
    } else if (
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      payload[target] = value;
    }
  }

  return payload;
}

async function updateProfiles(profiles) {
  const { permitted, primaryKey } = await getMetadata();

  const rows = await listRows();
  const index = indexRows(rows);

  const results = [];
  const selectedIds = new Set();

  for (const profile of profiles) {
    const name = String(profile.fullName || '').trim();

    if (
      !name ||
      typeof profile.fields !== 'object' ||
      !profile.fields ||
      Array.isArray(profile.fields)
    ) {
      results.push(
        fail('Missing name or invalid extracted fields')
      );
      continue;
    }

    const match = matchProfile(
      profile,
      index,
      primaryKey
    );

    if (!match.row) {
      results.push(match);
      continue;
    }

    const id = match.row[primaryKey];

    if (id === undefined || id === null) {
      results.push(
        fail(
          `Matched row has no ${primaryKey}; ` +
          'check NocoDB API response field names',
          'review'
        )
      );
      continue;
    }

    if (selectedIds.has(String(id))) {
      results.push(
        fail(
          'Another profile in this batch targeted ' +
          'the same NocoDB row',
          'review'
        )
      );
      continue;
    }

    selectedIds.add(String(id));

    const changes = buildChanges(
      profile.fields,
      permitted
    );

    if (!Object.keys(changes).length) {
      results.push(
        fail(
          'No nonempty mapped fields to update',
          'review',
          { recordId: id }
        )
      );
      continue;
    }

    // PATCH updates only the fields submitted.
    // ProfileURL and FullName are never included.
    try {
      await nocoRequest(
        `/api/v2/tables/${encodeURIComponent(TABLE_ID)}/records`,
        'PATCH',
        {
          [primaryKey]: id,
          ...changes
        }
      );

      results.push({
        status: match.review
          ? 'updated_review'
          : 'updated',
        recordId: id,
        method: match.method,
        reason: match.review
          ? 'Unique name fallback; verify the matched row'
          : '',
        fieldCount: Object.keys(changes).length
      });
    } catch (error) {
      results.push(
        fail(
          `Update failed: ${error.message}`,
          'failed',
          {
            recordId: id,
            method: match.method
          }
        )
      );
    }
  }

  return results;
}

function rateLimit(req) {
  const ip = String(
    req.socket.remoteAddress || 'unknown'
  );

  const now = Date.now();

  let slot = recent.get(ip);

  if (!slot || now - slot.s > 60000) {
    slot = { s: now, c: 0 };
  }

  slot.c++;
  recent.set(ip, slot);

  if (recent.size > 500) {
    for (const [key, value] of recent) {
      if (now - value.s > 60000) {
        recent.delete(key);
      }
    }
  }

  return slot.c <= 8;
}

async function readJSON(req) {
  let text = '';

  for await (const part of req) {
    text += part.toString('utf8');

    if (Buffer.byteLength(text) > MAX_BODY) {
      throw Error('Request too large');
    }
  }

  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  if (
    req.method === 'GET' &&
    (req.url === '/' || req.url === '/index.html')
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'none'; " +
        "frame-ancestors 'none'"
    });

    res.end(fs.readFileSync(STATIC_FILE));
    return;
  }

  if (
    req.url === '/health' &&
    req.method === 'GET'
  ) {
    send(res, 200, { ok: true });
    return;
  }

  if (
    req.url === '/api/update' &&
    req.method === 'POST'
  ) {
    // Reject cross-origin browser requests.
    // This is not user authentication.
    const origin = req.headers.origin;
    const host = req.headers.host;

    if (origin) {
      try {
        if (new URL(origin).host !== host) {
          send(res, 403, {
            error: 'Cross-origin requests are not accepted'
          });
          return;
        }
      } catch {
        send(res, 403, {
          error: 'Bad origin'
        });
        return;
      }
    }

    if (!rateLimit(req)) {
      send(res, 429, {
        error: 'Too many upload requests. Try again later.'
      });
      return;
    }

    if (!TOKEN) {
      send(res, 503, {
        error: 'NOCODB_API_TOKEN is not configured on Render.'
      });
      return;
    }

    try {
      const body = await readJSON(req);

      if (
        !Array.isArray(body.profiles) ||
        body.profiles.length < 1 ||
        body.profiles.length > MAX_BATCH
      ) {
        send(res, 400, {
          error: `Upload 1–${MAX_BATCH} profiles per request.`
        });
        return;
      }

      const results = await updateProfiles(
        body.profiles
      );

      send(res, 200, { results });
    } catch (error) {
      console.error('Upload error:', error.message);

      send(res, 502, {
        error: error.message
      });
    }

    return;
  }

  send(res, 404, { error: 'Not found' });
});

if (require.main === module) {
  server.listen(
    PORT,
    '0.0.0.0',
    () => console.log(
      `LinkedIn extractor listening on port ${PORT}`
    )
  );
}

module.exports = {
  normalizeProfile,
  normalizeName,
  matchProfile,
  indexRows,
  buildChanges,
  getPrimaryKeyColumn,
  updateProfiles,
  server
};
