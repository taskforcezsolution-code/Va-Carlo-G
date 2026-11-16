/**
 * VA Carlo G — CRM API (Cloudflare Worker, module syntax)
 *
 * Routes
 *   GET  /health               liveness check (no secrets)
 *   GET  /test-hubspot         read-only HubSpot connectivity check
 *   POST /api/inquiries        website inquiry -> HubSpot contact (create/update) + note + email notification
 *   POST /api/tally-webhook    optional: Tally form responses -> same pipeline (HMAC-verified)
 *
 * Secrets (wrangler secret put NAME):   HUBSPOT_ACCESS_TOKEN (existing)
 *                                       RESEND_API_KEY        (optional, email notifications)
 *                                       TALLY_SIGNING_SECRET  (optional, Tally webhook)
 * Variables:                            ALLOWED_ORIGINS, NOTIFY_TO, EMAIL_FROM
 * Optional bindings:                    INQUIRY_KV (duplicate protection), RATE_LIMITER (rate limiting)
 */

const HS_API = "https://api.hubapi.com";
const NOTE_TO_CONTACT = 202; // HubSpot-defined association type: note -> contact
const DEFAULT_ORIGIN = "https://vacarlog.taskforcezsolution.com";
const DEFAULT_NOTIFY_TO = "carlo.g@taskforcezsolution.com";
const LIMITS = { body: 20000, tallyBody: 100000, firstName: 80, lastName: 80, email: 254, phone: 25, company: 120, service: 120, subject: 150, message: 3000, source: 500, page: 150 };
const memory = { seen: new Map(), rate: new Map() }; // best-effort fallbacks when KV / rate limiter are not bound

/* ----------------------------- responses / CORS ----------------------------- */
const allowedOrigins = (env) => (env.ALLOWED_ORIGINS || DEFAULT_ORIGIN).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const originOk = (request, env) => { const o = request.headers.get("Origin"); return !!o && allowedOrigins(env).includes(o); };
function corsHeaders(request, env) {
  const o = request.headers.get("Origin");
  if (o && allowedOrigins(env).includes(o)) {
    return { "Access-Control-Allow-Origin": o, Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
  }
  return { Vary: "Origin" };
}
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
const fail = (status, code, message, extra = {}, fields) => json({ ok: false, error: { code, message, ...(fields ? { fields } : {}) } }, status, extra);

/* --------------------------------- router ----------------------------------- */
export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/health" && request.method === "GET") return json({ ok: true, service: "va-carlo-crm-api", time: new Date().toISOString() });
      if (path === "/test-hubspot" && request.method === "GET") return await testHubspot(env);
      if (path === "/api/inquiries") {
        if (request.method === "OPTIONS") {
          return originOk(request, env) ? new Response(null, { status: 204, headers: corsHeaders(request, env) }) : fail(403, "origin_not_allowed", "This origin is not allowed.");
        }
        if (request.method === "POST") return await handleInquiry(request, env, requestId);
        return fail(405, "method_not_allowed", "Use POST.", { Allow: "POST, OPTIONS" });
      }
      if (path === "/api/tally-webhook") {
        if (request.method === "POST") return await handleTally(request, env, requestId);
        return fail(405, "method_not_allowed", "Use POST.", { Allow: "POST" });
      }
      return fail(404, "not_found", "Not found.");
    } catch (err) {
      console.error(JSON.stringify({ requestId, event: "unhandled", message: String((err && err.message) || err) }));
      return fail(500, "internal_error", "Something went wrong. Please try again.", corsHeaders(request, env));
    }
  },
};

/* --------------------------------- handlers --------------------------------- */
async function handleInquiry(request, env, requestId) {
  const cors = corsHeaders(request, env);
  if (!originOk(request, env)) return fail(403, "origin_not_allowed", "This origin is not allowed.", cors);
  if (await limited(env, request.headers.get("CF-Connecting-IP") || "unknown")) {
    return fail(429, "rate_limited", "Too many requests. Please wait a few minutes and try again.", { ...cors, "Retry-After": "300" });
  }
  const parsed = await readJson(request, LIMITS.body);
  if (parsed.error) return fail(parsed.status, parsed.error, parsed.message, cors);
  const raw = parsed.data;
  if (typeof raw.website === "string" && raw.website.trim()) return json({ ok: true, status: "received", requestId }, 200, cors); // honeypot: pretend success, store nothing
  const v = validate(raw);
  if (v.errors) return fail(400, "validation_error", "Please check the highlighted fields.", cors, v.errors);
  const key = v.value.idempotencyKey ? "k:" + v.value.idempotencyKey : "h:" + (await sha256(`${v.value.email}|${v.value.service}|${v.value.message}`));
  if (await wasSeen(env, key)) return json({ ok: true, status: "already_received", duplicate: true, requestId }, 200, cors);
  const out = await processInquiry(env, { ...v.value, source: "website" }, requestId, key);
  if (out.ok) await markSeen(env, key);
  return json(out.body, out.status, cors);
}

async function handleTally(request, env, requestId) {
  if (!env.TALLY_SIGNING_SECRET) return fail(503, "webhook_not_configured", "Webhook is not configured.");
  const rawText = await request.text();
  if (rawText.length > LIMITS.tallyBody) return fail(413, "payload_too_large", "Payload too large.");
  if (!(await verifySignature(env.TALLY_SIGNING_SECRET, rawText, request.headers.get("tally-signature")))) return fail(401, "invalid_signature", "Invalid signature.");
  let evt;
  try { evt = JSON.parse(rawText); } catch { return fail(400, "invalid_json", "Invalid JSON."); }
  if (!evt || evt.eventType !== "FORM_RESPONSE" || !evt.data) return json({ ok: true, status: "ignored" });
  const mapped = mapTally(evt.data);
  const v = validate(mapped);
  if (v.errors) return fail(422, "validation_error", "The Tally response is missing a valid email address or name.", {}, v.errors);
  const key = "t:" + (evt.data.submissionId || evt.data.responseId || evt.eventId || (await sha256(rawText)));
  if (await wasSeen(env, key)) return json({ ok: true, status: "already_received", duplicate: true, requestId });
  const out = await processInquiry(env, { ...v.value, source: "tally" }, requestId, key);
  if (out.ok) await markSeen(env, key);
  return json(out.body, out.status);
}

async function testHubspot(env) {
  if (!env.HUBSPOT_ACCESS_TOKEN) return fail(500, "server_not_configured", "HubSpot is not configured.");
  const r = await hs(env, "GET", "/crm/v3/objects/contacts?limit=1");
  return json({ ok: r.status === 200, hubspotStatus: r.status }, r.status === 200 ? 200 : 502);
}

/* ------------------------------ core pipeline ------------------------------- */
async function processInquiry(env, inq, requestId, key) {
  const submittedAt = new Date().toISOString();
  let crm;
  try {
    crm = await upsertContact(env, inq);
  } catch (e) {
    console.error(JSON.stringify({ requestId, event: "crm_failed", code: e.code || "error", status: e.status || null }));
    // Do not lose the lead: send the owner a flagged copy by email, but report the CRM failure honestly.
    const backup = await notify(env, { ...inq, submittedAt, crmStatus: "failed", contactId: null, noteStatus: "skipped", requestId, key });
    const config = e.code === "config";
    return { ok: false, status: config ? 500 : 502, body: { ok: false, error: { code: config ? "server_not_configured" : "crm_error", message: "We couldn't save your message right now. Please try again in a moment." }, notification: backup, requestId } };
  }
  let note;
  try { note = { status: "created", id: await createNote(env, crm.contactId, inq, submittedAt) }; }
  catch (e) { console.error(JSON.stringify({ requestId, event: "note_failed", code: e.code || "error", status: e.status || null })); note = { status: "failed", code: e.code || "error" }; }
  const notification = await notify(env, { ...inq, submittedAt, crmStatus: crm.status, contactId: crm.contactId, noteStatus: note.status, requestId, key });
  return { ok: true, status: 200, body: { ok: true, status: crm.status, contactId: crm.contactId, note, notification, submittedAt, requestId } };
}

/* --------------------------------- HubSpot ---------------------------------- */
async function hs(env, method, path, body) {
  if (!env.HUBSPOT_ACCESS_TOKEN) { const e = new Error("HubSpot token missing"); e.code = "config"; throw e; }
  const attempt = () => fetch(HS_API + path, { method, headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let res = await attempt();
  if (res.status === 429 || res.status === 502 || res.status === 503) {
    const wait = Math.min(Number(res.headers.get("Retry-After")) || 1, 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    res = await attempt();
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}
function hubspotError(r, what) { const e = new Error(`${what} failed`); e.status = r.status; e.code = r.status === 401 || r.status === 403 ? "hubspot_auth" : `hubspot_${r.status}`; return e; }
const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ""));
const CONTACT_PROPS = ["email", "firstname", "lastname", "phone", "company"];

async function findContact(env, email) {
  const r = await hs(env, "POST", "/crm/v3/objects/contacts/search", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: CONTACT_PROPS, limit: 1 });
  if (r.status !== 200) throw hubspotError(r, "contact search");
  return (r.data && r.data.results && r.data.results[0]) || null;
}
async function getContact(env, id) {
  const r = await hs(env, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${CONTACT_PROPS.join(",")}`);
  return r.status === 200 ? r.data : null;
}
async function updateExisting(env, existing, inq) {
  const p = existing.properties || {};
  const changes = {};
  if (inq.firstName && !p.firstname) changes.firstname = inq.firstName;  // never replace a name that is already on file
  if (inq.lastName && !p.lastname) changes.lastname = inq.lastName;
  if (inq.phone && inq.phone !== p.phone) changes.phone = inq.phone;     // newer visitor-supplied details win, blanks never overwrite
  if (inq.company && inq.company !== p.company) changes.company = inq.company;
  if (Object.keys(changes).length) {
    const r = await hs(env, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, { properties: changes });
    if (r.status !== 200) throw hubspotError(r, "contact update");
  }
  return { contactId: String(existing.id), status: "updated" };
}
async function upsertContact(env, inq) {
  const found = await findContact(env, inq.email);
  if (found) return updateExisting(env, found, inq);
  const props = { email: inq.email, ...nonEmpty({ firstname: inq.firstName, lastname: inq.lastName, phone: inq.phone, company: inq.company }) };
  const r = await hs(env, "POST", "/crm/v3/objects/contacts", { properties: props });
  if (r.status === 200 || r.status === 201) return { contactId: String(r.data.id), status: "created" };
  if (r.status === 409) { // another request created the same contact first: fall back to update
    const m = /Existing ID:\s*(\d+)/i.exec((r.data && r.data.message) || "");
    if (m) return updateExisting(env, (await getContact(env, m[1])) || { id: m[1], properties: {} }, inq);
  }
  throw hubspotError(r, "contact create");
}
async function createNote(env, contactId, inq, submittedAt) {
  const lines = [`<p><strong>${inq.source === "tally" ? "Tally form inquiry" : "Website inquiry"}</strong> &mdash; ${esc(submittedAt)}</p>`];
  const meta = [["Service of interest", inq.service], ["Subject", inq.subject], ["Phone", inq.phone], ["Company", inq.company], ["Source page", inq.page], ["Source URL", inq.sourceUrl]];
  for (const [k, v] of meta) if (v) lines.push(`<p><strong>${k}:</strong> ${esc(v)}</p>`);
  lines.push(`<p><strong>Message:</strong><br>${esc(inq.message).replace(/\n/g, "<br>")}</p>`);
  const r = await hs(env, "POST", "/crm/v3/objects/notes", {
    properties: { hs_timestamp: submittedAt, hs_note_body: lines.join("") },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
  });
  if (r.status !== 200 && r.status !== 201) throw hubspotError(r, "note create");
  return String(r.data.id);
}

/* ------------------------------ email (Resend) ------------------------------ */
async function notify(env, d) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { status: "not_configured" };
  const name = [d.firstName, d.lastName].filter(Boolean).join(" ");
  const flag = d.crmStatus === "failed" ? "[HubSpot NOT saved] " : "";
  const subject = `${flag}New inquiry: ${name}${d.service ? " - " + d.service : ""}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  const rows = [["Name", name], ["Email", d.email], ["Phone", d.phone], ["Company", d.company], ["Service of interest", d.service], ["Subject", d.subject], ["Source", d.source === "tally" ? "Tally form" : "Website form"], ["Source page", d.page], ["Source URL", d.sourceUrl], ["Submitted (UTC)", d.submittedAt],
    ["HubSpot contact ID", d.contactId || "not saved"], ["HubSpot result", d.crmStatus], ["HubSpot note", d.noteStatus]].filter(([, v]) => v);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nMessage:\n${d.message}\n`;
  const html = `<table cellpadding="6" style="font:14px system-ui,sans-serif;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#6b5240"><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`).join("")}</table><p style="font:14px system-ui,sans-serif"><strong>Message</strong><br>${esc(d.message).replace(/\n/g, "<br>")}</p>`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": "inq-" + (d.key || d.requestId).slice(0, 200) },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.NOTIFY_TO || DEFAULT_NOTIFY_TO], reply_to: d.email, subject, text, html }),
    });
    const body = await res.json().catch(() => ({}));
    // "accepted" = the provider accepted the message for delivery (it returned an id). Final delivery is visible in the provider's logs.
    if (res.ok && body && body.id) return { status: "accepted", providerId: body.id };
    return { status: "failed", code: `http_${res.status}` };
  } catch (e) {
    return { status: "failed", code: e && e.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(timer); }
}

/* ------------------------- validation / sanitising -------------------------- */
const strip = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
const clean = (v, max) => (typeof v === "string" ? strip(v).replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanText = (v, max) => (typeof v === "string" ? strip(v.replace(/\r\n?/g, "\n")).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "");
function validate(raw) {
  const errors = {};
  let firstName = clean(raw.firstName, LIMITS.firstName), lastName = clean(raw.lastName, LIMITS.lastName);
  if (!firstName && typeof raw.name === "string") { const parts = clean(raw.name, LIMITS.firstName + LIMITS.lastName).split(" "); firstName = parts.shift() || ""; lastName = lastName || parts.join(" ").slice(0, LIMITS.lastName); }
  const email = clean(raw.email, LIMITS.email + 1).toLowerCase();
  const phone = clean(raw.phone, LIMITS.phone + 1);
  const message = cleanText(raw.message, LIMITS.message + 1);
  if (!firstName) errors.firstName = "Please enter your first name.";
  if (!email) errors.email = "Please enter your email address.";
  else if (email.length > LIMITS.email || !/^[^\s@,;<>()"']{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(email)) errors.email = "Please enter a valid email address.";
  if (phone && (phone.length > LIMITS.phone || !/^[0-9+().\-\s]{5,25}$/.test(phone) || phone.replace(/\D/g, "").length < 5)) errors.phone = "Please enter a valid phone number.";
  if (!message) errors.message = "Please write a short message.";
  else if (message.length < 5) errors.message = "Your message is a little short.";
  else if (message.length > LIMITS.message) errors.message = `Please keep your message under ${LIMITS.message} characters.`;
  if (typeof raw.company === "string" && raw.company.length > LIMITS.company * 2) errors.company = "That company name is too long.";
  if (Object.keys(errors).length) return { errors };
  let sourceUrl = "";
  try { const u = new URL(clean(raw.sourceUrl, LIMITS.source)); if (u.protocol === "https:" || u.protocol === "http:") sourceUrl = u.href.slice(0, LIMITS.source); } catch { /* ignore invalid */ }
  const idem = typeof raw.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.idempotencyKey) ? raw.idempotencyKey : "";
  return { value: { firstName, lastName, email, phone, company: clean(raw.company, LIMITS.company), service: clean(raw.service, LIMITS.service), subject: clean(raw.subject, LIMITS.subject), message, sourceUrl, page: clean(raw.page, LIMITS.page), idempotencyKey: idem } };
}
async function readJson(request, max) {
  const type = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!type.includes("application/json")) return { error: "unsupported_media_type", status: 415, message: "Send the request as JSON." };
  const declared = Number(request.headers.get("Content-Length"));
  if (declared && declared > max) return { error: "payload_too_large", status: 413, message: "That request is too large." };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return { error: "payload_too_large", status: 413, message: "That request is too large." };
  try { const data = JSON.parse(text); if (data && typeof data === "object" && !Array.isArray(data)) return { data }; } catch { /* fall through */ }
  return { error: "invalid_json", status: 400, message: "The request body is not valid JSON." };
}

/* ------------------------------ Tally mapping ------------------------------- */
function mapTally(data) {
  const out = { source: "tally", sourceUrl: data.formId ? `https://tally.so/r/${data.formId}` : "", page: data.formName ? `Tally form: ${data.formName}` : "Tally form" };
  const extra = [], messages = [];
  const valueText = (f) => {
    const v = f.value;
    if (Array.isArray(v)) return v.map((x) => ((f.options || []).find((o) => o.id === x) || {}).text || (typeof x === "string" ? x : "")).filter(Boolean).join(", ");
    if (v === null || v === undefined) return "";
    return typeof v === "object" ? "" : String(v);
  };
  for (const f of data.fields || []) {
    const label = String(f.label || ""), val = valueText(f).trim();
    if (!val) continue;
    if (f.type === "INPUT_EMAIL" || (!out.email && /e-?mail/i.test(label))) out.email = val;
    else if (f.type === "INPUT_PHONE_NUMBER" || /phone|mobile|whatsapp/i.test(label)) out.phone = val;
    else if (/^(first|given)\s*name$/i.test(label)) out.firstName = val;
    else if (/^(last|sur|family)\s*name$/i.test(label)) out.lastName = val;
    else if (/^(full\s*)?name$|^your name$/i.test(label)) out.name = val;
    else if (/company|business|organi[sz]ation/i.test(label)) out.company = val;
    else if ((f.type === "HIDDEN_FIELDS" && /^service$/i.test(label)) || /^service/i.test(label)) out.service = val;
    else if (/subject|topic/i.test(label)) out.subject = val;
    else if (f.type === "TEXTAREA") messages.push(messages.length ? `${label}: ${val}` : val);
    else extra.push(`${label}: ${val}`);
  }
  out.message = [...messages, ...(extra.length ? ["", "Other answers:", ...extra] : [])].join("\n").trim() || "Submitted through the Tally form (no message text).";
  return out;
}
async function verifySignature(secret, rawBody, signature) {
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  let bin = ""; for (const b of mac) bin += String.fromCharCode(b);
  return safeEqual(btoa(bin), signature.trim());
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/* ------------------------- duplicate + rate limiting ------------------------ */
async function wasSeen(env, key) {
  if (env.INQUIRY_KV) return !!(await env.INQUIRY_KV.get("seen:" + key));
  const exp = memory.seen.get(key); if (exp && exp > Date.now()) return true; memory.seen.delete(key); return false;
}
async function markSeen(env, key) {
  if (env.INQUIRY_KV) { await env.INQUIRY_KV.put("seen:" + key, "1", { expirationTtl: 600 }); return; }
  memory.seen.set(key, Date.now() + 600000);
  if (memory.seen.size > 2000) for (const [k, t] of memory.seen) if (t < Date.now()) memory.seen.delete(k);
}
async function limited(env, ip) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") return !(await env.RATE_LIMITER.limit({ key: ip })).success;
  const now = Date.now(), win = 600000, max = 8;
  const hits = (memory.rate.get(ip) || []).filter((t) => now - t < win); hits.push(now); memory.rate.set(ip, hits);
  if (memory.rate.size > 5000) for (const [k, a] of memory.rate) if (!a.some((t) => now - t < win)) memory.rate.delete(k);
  return hits.length > max;
}

/* --------------------------------- helpers ---------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
async function sha256(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
