// Runs the whole app on this machine: the Netlify functions are served by a
// small local server backed by a JSON file (.local-data/), and Vite proxies to
// it. No Airtable, Composio or Netlify account is needed.
//
//   npm run dev:local
//
// Settings are read from .env.local (see .env.local.example).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const functionsDir = path.join(root, 'netlify', 'functions');

// ---- settings -----------------------------------------------------------
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || line.trim().startsWith('#')) continue;
        const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
        if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
}

const dataDir = path.join(root, '.local-data');
fs.mkdirSync(dataDir, { recursive: true });

process.env.MATAI_LOCAL = '1';
process.env.MATAI_LOCAL_DIR = dataDir;
process.env.AUTOM8_AIRTABLE_BASE_ID ||= 'local';
process.env.CHAMPION_AIRTABLE_BASE_ID ||= 'local';
if (!process.env.MATAI_SESSION_SECRET) {
    const secretFile = path.join(dataDir, 'session-secret');
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    process.env.MATAI_SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}

const backendPort = Number(process.env.MATAI_BACKEND_PORT || 8888);
const name = String(process.env.MATAI_LOCAL_NAME || 'admin').trim();
const pin = String(process.env.MATAI_LOCAL_PIN || '1234').trim();
const kieKey = String(process.env.KIE_API_KEY || process.env.KIE_AI_API_KEY || '').trim();
const falKey = String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
const elevenKey = String(process.env.ELEVENLABS_API_KEY || '').trim();

// ---- local account --------------------------------------------------------
// The sign-in screen checks a name + PIN against the account table, and each
// account carries its own provider keys. Keep one account in step with
// .env.local on every start.
const store = require(path.join(functionsDir, '_local-store.js'));
const ACCOUNTS = 'tbloKNK7pmGiaEB1K';
{
    const db = store.load();
    const rows = db.tables[ACCOUNTS] || (db.tables[ACCOUNTS] = []);
    let account = rows.find((row) => row.fields?.Local === true);
    if (!account) {
        account = { id: store.newId(), createdTime: new Date().toISOString(), fields: { Local: true } };
        rows.push(account);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const fields = account.fields;
    fields['First Name'] = name;
    fields['PIN Hash'] = `${salt}:${crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex')}`;
    fields.Status = 'Active';
    for (const [field, value] of [['Kie API Key', kieKey], ['fal API Key', falKey], ['ElevenLabs API Key', elevenKey]]) {
        if (value) fields[field] = value; else delete fields[field];
    }
    // Lets the account in; a request that needs a missing key says so itself.
    fields['Provider Setup Complete'] = true;
    for (const stale of ['Locked Until', 'Failed Login Attempts', 'Failed Window Started']) delete fields[stale];
    store.save(db);
}

// ---- function server ------------------------------------------------------
const handlers = new Map();
function handlerFor(fn) {
    if (!/^[a-z][a-z0-9-]*$/.test(fn)) return null;
    if (!handlers.has(fn)) {
        const file = path.join(functionsDir, `${fn}.js`);
        handlers.set(fn, fs.existsSync(file) ? require(file).handler : null);
    }
    return handlers.get(fn);
}

let mediaDownload;
async function edgeDownload(req, res, url) {
    mediaDownload ||= (await import(pathToFileURL(path.join(root, 'netlify', 'edge-functions', 'media-download.js')).href)).default;
    const response = await mediaDownload(new Request(url));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    for await (const chunk of response.body) res.write(chunk);
    res.end();
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/download-media') return await edgeDownload(req, res, url);

        const match = /^\/(?:\.netlify\/functions|api)\/([^/]+)/.exec(url.pathname);
        const handler = match && handlerFor(match[1]);
        if (!handler) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not found' }));
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const result = await handler({
            httpMethod: req.method,
            path: url.pathname,
            headers: req.headers,
            queryStringParameters: Object.fromEntries(url.searchParams),
            body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
            isBase64Encoded: false,
        }, {}) || { statusCode: 204 };

        const headers = { ...(result.headers || {}), ...(result.multiValueHeaders || {}) };
        // Plain http://localhost: browsers that refuse "Secure" cookies there would never sign in.
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() !== 'set-cookie') continue;
            const strip = (cookie) => String(cookie).replace(/;\s*Secure/i, '');
            headers[key] = Array.isArray(headers[key]) ? headers[key].map(strip) : strip(headers[key]);
        }
        res.writeHead(result.statusCode || 200, headers);
        res.end(result.isBase64Encoded ? Buffer.from(result.body || '', 'base64') : (result.body || ''));
    } catch (error) {
        console.error('[local-dev]', error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(backendPort, '127.0.0.1', resolve);
});

// ---- frontend -------------------------------------------------------------
process.env.MATAI_BACKEND = `http://127.0.0.1:${backendPort}`;
const { createServer } = await import('vite');
const vite = await createServer({
    root,
    server: { host: process.env.MATAI_HOST || 'localhost', port: Number(process.env.PORT || 5173) },
});
await vite.listen();

console.log('\n  MATAI is running locally\n');
vite.printUrls();
console.log(`\n  Sign in with   first name: ${name}   PIN: ${pin}`);
console.log(`  Kie.ai key:    ${kieKey ? 'set' : 'missing - add KIE_API_KEY to .env.local to generate'}`);
console.log(`  fal.ai key:    ${falKey ? 'set' : 'not set (optional)'}`);
console.log(`  Data folder:   ${path.relative(root, dataDir)}/\n`);
