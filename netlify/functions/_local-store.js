// Local development storage. When MATAI_LOCAL=1 the Airtable calls that
// normally travel through Composio are answered from a JSON file on disk, so
// the app can run on one machine with no Airtable or Composio account.
// Only the parts of the Airtable REST API that this backend uses are covered.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = process.env.MATAI_LOCAL_DIR || path.join(__dirname, '..', '..', '.local-data')
const DATA_FILE = path.join(DATA_DIR, 'store.json')

const enabled = () => process.env.MATAI_LOCAL === '1'

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } catch { return { tables: {} } }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${DATA_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, DATA_FILE)
}

const newId = () => `rec${crypto.randomBytes(10).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 14)}`

// ---- Airtable formula subset: OR/AND/NOT, LOWER, FIND, {Field}, '=' and '>' ----
function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '{') {
      const end = src.indexOf('}', i)
      if (end < 0) throw new Error('Unclosed field reference')
      tokens.push({ t: 'field', v: src.slice(i + 1, end) }); i = end + 1; continue
    }
    if (c === "'" || c === '"') {
      let out = ''
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2 } else { out += src[i]; i++ }
      }
      if (i >= src.length) throw new Error('Unclosed string')
      tokens.push({ t: 'str', v: out }); i++; continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      tokens.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z_]/.test(src[j])) j++
      tokens.push({ t: 'name', v: src.slice(i, j).toUpperCase() }); i = j; continue
    }
    const two = src.slice(i, i + 2)
    if (['>=', '<=', '!='].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue }
    if ('=><(),'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue }
    throw new Error(`Unsupported character "${c}" in formula`)
  }
  return tokens
}

function compileFormula(src) {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const take = (v) => {
    const tok = tokens[pos++]
    if (!tok || (v && tok.v !== v)) throw new Error(`Unexpected token in formula near position ${pos}`)
    return tok
  }

  function primary() {
    const tok = take()
    if (tok.t === 'field') return (f) => (f[tok.v] === undefined || f[tok.v] === null ? '' : f[tok.v])
    if (tok.t === 'str' || tok.t === 'num') return () => tok.v
    if (tok.t === 'op' && tok.v === '(') { const inner = comparison(); take(')'); return inner }
    if (tok.t === 'name') {
      take('(')
      const args = []
      if (peek() && peek().v !== ')') {
        args.push(comparison())
        while (peek() && peek().v === ',') { take(','); args.push(comparison()) }
      }
      take(')')
      switch (tok.v) {
        case 'OR': return (f) => args.some((a) => Boolean(a(f)))
        case 'AND': return (f) => args.every((a) => Boolean(a(f)))
        case 'NOT': return (f) => !args[0](f)
        case 'LOWER': return (f) => String(args[0](f)).toLowerCase()
        case 'UPPER': return (f) => String(args[0](f)).toUpperCase()
        case 'TRIM': return (f) => String(args[0](f)).trim()
        case 'FIND': return (f) => String(args[1](f)).indexOf(String(args[0](f))) + 1
        default: throw new Error(`Unsupported formula function ${tok.v}()`)
      }
    }
    throw new Error('Unexpected token in formula')
  }

  function comparison() {
    const left = primary()
    const tok = peek()
    if (!tok || tok.t !== 'op' || !['=', '!=', '>', '<', '>=', '<='].includes(tok.v)) return left
    take()
    const right = primary()
    return (f) => {
      const a = left(f)
      const b = right(f)
      switch (tok.v) {
        case '=': return String(a) === String(b)
        case '!=': return String(a) !== String(b)
        case '>': return Number(a) > Number(b)
        case '<': return Number(a) < Number(b)
        case '>=': return Number(a) >= Number(b)
        default: return Number(a) <= Number(b)
      }
    }
  }

  const run = comparison()
  if (pos !== tokens.length) throw new Error('Unexpected trailing text in formula')
  return (fields) => Boolean(run(fields))
}

const MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav',
}

// Mirror how Airtable stores values: null/empty clears a field, and
// attachment arrays gain an id and a content type.
function applyFields(target, incoming) {
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === null || value === undefined || value === '' || value === false) { delete target[key]; continue }
    if (Array.isArray(value) && value.length && value.every((v) => v && typeof v === 'object' && typeof v.url === 'string')) {
      target[key] = value.map((item) => {
        const ext = (/\.([a-z0-9]+)(?:\?|$)/i.exec(item.filename || item.url) || [])[1]
        return { id: item.id || `att${crypto.randomBytes(7).toString('hex')}`, type: MIME[String(ext || '').toLowerCase()] || '', ...item }
      })
      continue
    }
    target[key] = value
  }
  return target
}

const reply = (status, body) => {
  const text = JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, text, json: () => body }
}
const fail = (status, type, message) => reply(status, { error: { type, message } })

// fetch()-shaped answer for an https://api.airtable.com/v0/{base}/{table}[/{record}] URL.
function handle(url, options = {}) {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean) // v0, base, table, [record]
  const table = decodeURIComponent(parts[2] || '')
  const recordId = parts[3] ? decodeURIComponent(parts[3]) : ''
  if (!table) return fail(404, 'NOT_FOUND', 'Table not found')
  const method = String(options.method || 'GET').toUpperCase()

  let body = options.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { return fail(422, 'INVALID_REQUEST_BODY', 'Could not parse request body') } }

  const db = load()
  const rows = db.tables[table] || (db.tables[table] = [])
  const find = () => rows.find((row) => row.id === recordId)

  if (method === 'GET' && recordId) {
    const row = find()
    return row ? reply(200, row) : fail(404, 'MODEL_ID_NOT_FOUND', 'Record not found')
  }

  if (method === 'GET') {
    let out = rows.slice()
    const formula = parsed.searchParams.get('filterByFormula')
    if (formula) {
      let test
      try { test = compileFormula(formula) } catch (error) { return fail(422, 'INVALID_FILTER_BY_FORMULA', error.message) }
      out = out.filter((row) => test(row.fields || {}))
    }
    const sortField = parsed.searchParams.get('sort[0][field]')
    if (sortField) {
      const dir = parsed.searchParams.get('sort[0][direction]') === 'desc' ? -1 : 1
      const value = (row) => (sortField === 'Created' ? (row.fields?.Created || row.createdTime) : row.fields?.[sortField]) ?? ''
      out.sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0))
    }
    const limit = Math.min(Number(parsed.searchParams.get('maxRecords')) || Infinity, Number(parsed.searchParams.get('pageSize')) || 100)
    return reply(200, { records: out.slice(0, limit) })
  }

  if (method === 'POST') {
    const row = { id: newId(), createdTime: new Date().toISOString(), fields: applyFields({}, body?.fields) }
    rows.push(row)
    save(db)
    return reply(200, row)
  }

  if (method === 'PATCH' || method === 'PUT') {
    const row = find()
    if (!row) return fail(404, 'MODEL_ID_NOT_FOUND', 'Record not found')
    row.fields = applyFields(method === 'PUT' ? {} : row.fields || {}, body?.fields)
    save(db)
    return reply(200, row)
  }

  if (method === 'DELETE') {
    const index = rows.findIndex((row) => row.id === recordId)
    if (index < 0) return fail(404, 'MODEL_ID_NOT_FOUND', 'Record not found')
    rows.splice(index, 1)
    save(db)
    return reply(200, { deleted: true, id: recordId })
  }

  return fail(405, 'METHOD_NOT_ALLOWED', `Unsupported method ${method}`)
}

module.exports = { enabled, handle, load, save, newId, compileFormula, DATA_DIR, DATA_FILE }
