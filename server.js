'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mapping = require('./field-mapping.json');
const PORT = Number(process.env.PORT || 3000);
const NOCODB_URL = (process.env.NOCODB_URL || 'https://cricexec-nocodb-prod.onrender.com').replace(/\/+$/, '');
const TABLE_ID = process.env.NOCODB_TABLE_ID || 'mlb0mtz902gqwg9';
const TOKEN = process.env.NOCODB_API_TOKEN || '';
const STATIC_FILE = path.join(__dirname, 'public/index.html');
const READ_ONLY = new Set(['ProfileURL', 'FullName']);
const MAX_MATCH_ROWS = 500;
const PAGE_SIZE = 100;
const MAX_BATCH = 25;
const MAX_BODY = 1024 * 1024;
const recent = new Map();

function normalizeProfile(v) {
  try {
    const url = new URL(String(v || '').trim().replace(/&amp;/g, '&'));
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';
    const pieces = url.pathname.split('/').filter(Boolean);
    return pieces[0]?.toLowerCase() === 'in' && pieces[1] ? decodeURIComponent(pieces[1]).toLowerCase() : '';
  } catch { return ''; }
}
function normalizeName(v) { return String(v || '').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim(); }
function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  res.end(JSON.stringify(payload));
}
function fail(reason, status='failed', extra={}) { return {status,reason,...extra}; }
async function nocoRequest(urlPath, method='GET', body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(NOCODB_URL + urlPath, {
      method,
      headers: {'xc-token': TOKEN, ...(body === undefined ? {} : {'Content-Type':'application/json'})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:controller.signal
    });
    const raw = await response.text();
    let parsed;
    try {parsed=JSON.parse(raw);} catch {parsed=raw;}
    if (!response.ok) throw Error(`NocoDB HTTP ${response.status}: ${typeof parsed === 'string' ? parsed.slice(0,150) : JSON.stringify(parsed).slice(0,150)}`);
    return parsed;
  } finally { clearTimeout(timer); }
}
function getPrimaryKeyColumn(cols) {
  // Use the NocoDB API field title, not the physical PostgreSQL column name.
  // In public.individuals the physical primary key is uppercase "ID".
  const keys = cols.filter(c => c.pk === true || c.pk === 1 || c.pk === '1');
  if (keys.length > 1) throw Error('NocoDB reports multiple primary key fields; composite keys are unsupported. No records updated.');
  const key = keys[0] || cols.find(c => String(c.title || '').toLowerCase() === 'id');
  if (!key || !key.title) throw Error('Could not identify the NocoDB primary key field. No records updated.');
  return key.title;
}
async function getMetadata() {
  const data = await nocoRequest(`/api/v2/meta/tables/${encodeURIComponent(TABLE_ID)}`);
  const cols = data.columns || [];
  const titles = new Set(cols.map(c=>c.title));
  for (const key of ['ProfileURL','FullName']) {
    if (!titles.has(key)) throw Error(`Required NocoDB field '${key}' is missing. No records updated.`);
  }
  const primaryKey = getPrimaryKeyColumn(cols);
  const writeTypes = new Set(['SingleLineText','LongText','URL','Email','PhoneNumber','Number','Decimal','Currency','Percent','SingleSelect']);
  const permitted = new Set(cols.filter(c=>writeTypes.has(c.uidt)&&!c.system&& !READ_ONLY.has(c.title) && c.title!==primaryKey).map(c=>c.title));
  const bad = Object.values(mapping).filter(t=>!permitted.has(t));
  if (bad.length) throw Error(`Missing or unsupported mapped columns: ${bad.join(', ')}. No records updated.`);
  return {permitted,primaryKey};
}
// Query NocoDB for relevant rows only. The returned rows are rechecked locally:
// a contains search is never sufficient to select an update target.
async function findRows(column, searchTerm, primaryKey) {
  if (!['ProfileURL', 'FullName'].includes(column)) {
    throw Error('Unsupported lookup field');
  }
  const found = [];
  for (let offset = 0; offset <= MAX_MATCH_ROWS; ) {
    const params = new URLSearchParams({
      where: `(${column},like,${searchTerm})`,
      fields: [primaryKey, 'ProfileURL', 'FullName'].join(','),
      limit: String(PAGE_SIZE),
      offset: String(offset)
    });
    const data = await nocoRequest(
      `/api/v2/tables/${encodeURIComponent(TABLE_ID)}/records?${params}`
    );
    if (!Array.isArray(data.list)) {
      throw Error('NocoDB lookup returned an unexpected response; no update attempted.');
    }
    found.push(...data.list);
    if (found.length > MAX_MATCH_ROWS) {
      throw Error(`More than ${MAX_MATCH_ROWS} lookup results; refusing to choose a row.`);
    }
    if (data.pageInfo?.isLastPage === true || data.list.length === 0) {
      return found;
    }
    // Use returned page size, not requested limit: NocoDB may cap the page size.
    offset += data.list.length;
    if (Number.isFinite(Number(data.pageInfo?.totalRows)) &&
        offset >= Number(data.pageInfo.totalRows)) {
      return found;
    }
    if (data.list.length < PAGE_SIZE && !data.pageInfo) return found;
  }
  throw Error('Lookup exceeded the safety limit; no update attempted.');
}

function searchableUrlSlug(profileUrl) {
  const slug = normalizeProfile(profileUrl);
  // Do not interpolate URL punctuation or wildcard characters into a v2 filter.
  return /^[a-z0-9][a-z0-9-]{2,}$/i.test(slug) ? slug : '';
}

function searchableName(fullName) {
  const name = String(fullName || '').normalize('NFKC').trim();
  // These characters are special in NocoDB's legacy where syntax / SQL LIKE.
  if (name && /^[\p{L}\p{N} .'-]+$/u.test(name) && name.length <= 150) {
    return name;
  }
  // For uncommon names containing delimiters, query by a safe word and
  // verify the full normalized name in JavaScript before selecting any row.
  const words = name.match(/[\p{L}\p{N}-]{3,}/gu) || [];
  return words.sort((a,b) => b.length-a.length)[0] || '';
}

async function findProfileMatch(profile, primaryKey) {
  const slug = searchableUrlSlug(profile.profileUrl);
  let urlRows = [];
  if (slug) urlRows = await findRows('ProfileURL', slug, primaryKey);
  const exactUrlRows = urlRows.filter(
    row => normalizeProfile(row.ProfileURL) === slug
  );
  if (exactUrlRows.length > 1) {
    return fail(`${exactUrlRows.length} rows share the profile URL`, 'review');
  }
  if (exactUrlRows.length === 1) {
    const row = exactUrlRows[0];
    return { row, method: 'ProfileURL', review: false };
  }

  const nameTerm = searchableName(profile.fullName);
  if (!nameTerm) {
    return fail('No safe name or LinkedIn URL available for matching', 'review');
  }
  const nameRows = await findRows('FullName', nameTerm, primaryKey);
  const exactNameRows = nameRows.filter(
    row => normalizeName(row.FullName) === normalizeName(profile.fullName)
  );
  if (exactNameRows.length > 1) {
    return fail(`${exactNameRows.length} rows share FullName; manual review required`, 'review');
  }
  if (!exactNameRows.length) {
    return fail('No ProfileURL or FullName match in the NocoDB table', 'unmatched');
  }
  const row = exactNameRows[0];
  const savedSlug = normalizeProfile(row.ProfileURL);
  const uploadedSlug = normalizeProfile(profile.profileUrl);
  if (savedSlug && uploadedSlug && savedSlug !== uploadedSlug) {
    return fail('Name matched, but ProfileURL differs; manual review required', 'review');
  }
  return {row, method:'FullName', review:true};
}

function indexRows(rows) {
  const byUrl=new Map(),byName=new Map();
  for(const r of rows){
    const u=normalizeProfile(r.ProfileURL),n=normalizeName(r.FullName);
    if(u){if(!byUrl.has(u))byUrl.set(u,[]);byUrl.get(u).push(r);}
    if(n){if(!byName.has(n))byName.set(n,[]);byName.get(n).push(r);}
  }
  return {byUrl,byName};
}
function matchProfile(profile, index, primaryKey = 'Id') {
  const u=normalizeProfile(profile.profileUrl),n=normalizeName(profile.fullName);
  const urls=u?(index.byUrl.get(u)||[]):[];
  const names=n?(index.byName.get(n)||[]):[];
  if(urls.length>1)return fail(`${urls.length} rows share the profile URL`, 'review');
  if(urls.length===1){
    const row=urls[0];
    if(names.length===1 && String(names[0][primaryKey])!==String(row[primaryKey]))return fail('URL and name identify different rows', 'review');
    return {row,method:'ProfileURL',review:false};
  }
  if(names.length>1)return fail(`${names.length} rows share FullName; cannot safely use name fallback`, 'review');
  if(names.length===1) {
    const row=names[0];
    // Different populated URLs are contradictory. Never silently overwrite the wrong person.
    const stored=normalizeProfile(row.ProfileURL);
    if(stored && u && stored!==u)return fail('Name matched, but ProfileURL differs; manual review required','review');
    return {row,method:'FullName',review:true};
  }
  return fail('No ProfileURL or FullName match in the NocoDB table','unmatched');
}
function buildChanges(fields, permitted) {
  const payload={};
  for(const [source,target] of Object.entries(mapping)){
    if(READ_ONLY.has(target)||!permitted.has(target))continue;
    const v=fields[source];
    if(typeof v==='string'&&v.trim())payload[target]=v.trim();
    else if(typeof v==='number'&&Number.isFinite(v))payload[target]=v;
  }
  return payload;
}
async function updateProfiles(profiles, onResult = () => {}) {
  const {permitted,primaryKey}=await getMetadata();
  const results=[];
  const addResult = result => {
    results.push(result);
    onResult(result, results.length);
  };
  const selectedIds=new Set();
  for(const profile of profiles){
    const name=String(profile.fullName||'').trim();
    if((!name && !searchableUrlSlug(profile.profileUrl)) || typeof profile.fields!=='object' || !profile.fields || Array.isArray(profile.fields)){
      addResult(fail('Missing profile identifier or invalid extracted fields'));continue;
    }
    let match;
    try {
      match = await findProfileMatch(profile, primaryKey);
    } catch (error) {
      addResult(fail(`Lookup failed: ${error.message}`));
      continue;
    }
    if(!match.row){addResult(match);continue;}
    const id=match.row[primaryKey];
    if(id===undefined||id===null){addResult(fail(`Matched row has no ${primaryKey}; check NocoDB API response field names`,'review'));continue;}
    if(selectedIds.has(String(id))){addResult(fail('Another profile in this batch targeted the same NocoDB row','review'));continue;}
    selectedIds.add(String(id));
    const changes=buildChanges(profile.fields,permitted);
    if(!Object.keys(changes).length){addResult(fail('No nonempty mapped fields to update','review',{recordId:id}));continue;}
    // NocoDB v2 PATCH updates only submitted properties. Never include identifier columns.
    try {
      await nocoRequest(`/api/v2/tables/${encodeURIComponent(TABLE_ID)}/records`, 'PATCH', {[primaryKey]:id,...changes});
      addResult({status:match.review?'updated_review':'updated',recordId:id,method:match.method,reason:match.review?'Unique name fallback; verify the matched row':'' ,fieldCount:Object.keys(changes).length});
    } catch(error){addResult(fail(`Update failed: ${error.message}`,'failed',{recordId:id,method:match.method}));}
  }
  return results;
}
function rateLimit(req) {
  const ip=String(req.socket.remoteAddress||'unknown');const now=Date.now();
  let slot=recent.get(ip);if(!slot||now-slot.s>60000)slot={s:now,c:0};slot.c++;recent.set(ip,slot);
  if(recent.size>500)for(const [key,val] of recent)if(now-val.s>60000)recent.delete(key);
  return slot.c<=8;
}
async function readJSON(req) {
  let text='';
  for await (const part of req){ text+=part.toString('utf8');if(Buffer.byteLength(text)>MAX_BODY)throw Error('Request too large'); }
  return JSON.parse(text);
}
const server = http.createServer(async(req,res)=>{
  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(fs.readFileSync(STATIC_FILE));return;
  }
  if(req.url==='/health'&&req.method==='GET'){send(res,200,{ok:true});return;}
  if((req.url==='/api/update'||req.url==='/api/update-stream')&&req.method==='POST'){
    // Cross-origin browser requests are refused. This is not user authentication.
    const origin=req.headers.origin;
    const host=req.headers.host;
    if(origin){try {if(new URL(origin).host!==host){send(res,403,{error:'Cross-origin requests are not accepted'});return;}}catch{send(res,403,{error:'Bad origin'});return;}}
    if(!rateLimit(req)){send(res,429,{error:'Too many upload requests. Try again later.'});return;}
    if(!TOKEN){send(res,503,{error:'NOCODB_API_TOKEN is not configured on Render.'});return;}
    try{
      const body=await readJSON(req);
      if(!Array.isArray(body.profiles)||body.profiles.length<1||body.profiles.length>MAX_BATCH){send(res,400,{error:`Upload 1–${MAX_BATCH} profiles per request.`});return;}
      if (req.url === '/api/update-stream') {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Content-Type-Options': 'nosniff',
          'X-Accel-Buffering': 'no'
        });
        const emit = event => {
          if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
        };
        // Send an initial event immediately and then one result per profile.
        emit({type:'started', total:body.profiles.length});
        try {
          await updateProfiles(body.profiles, (result, index) => {
            emit({type:'result', index:index-1, result});
          });
          emit({type:'done'});
        } catch (error) {
          console.error('Streaming upload error:', error.message);
          emit({type:'error', error:error.message});
        }
        res.end();
      } else {
        const results=await updateProfiles(body.profiles);
        send(res,200,{results});
      }
    }catch(error){
      console.error('Upload error:',error.message);
      if (!res.headersSent) send(res,502,{error:error.message});
      else if (!res.writableEnded) res.end();
    }
    return;
  }
  send(res,404,{error:'Not found'});
});
if(require.main===module) server.listen(PORT,'0.0.0.0',()=>console.log(`LinkedIn extractor listening on port ${PORT}`));
module.exports={normalizeProfile,normalizeName,matchProfile,indexRows,buildChanges,getPrimaryKeyColumn,findRows,findProfileMatch,searchableUrlSlug,searchableName,updateProfiles,server};
