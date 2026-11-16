// Offline tests: the Worker runs unchanged; HubSpot and Resend are replaced by an in-memory simulation.
import worker from "../index.js";
import { createHmac } from "node:crypto";

const ORIGIN = "https://vacarlog.taskforcezsolution.com";
const TOKEN = "pat-na1-SECRET-TOKEN-VALUE";
let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log("  PASS", name); } else { failed++; console.log("  FAIL", name, extra); } };

/* ---------------- in-memory HubSpot + Resend simulation ---------------- */
function makeWorld(opts = {}) {
  const w = { contacts: new Map(), notes: [], emails: [], calls: [], nextId: 1000, noteFails: !!opts.noteFails, createFails: !!opts.createFails, searchBlind: !!opts.searchBlind, emailFails: !!opts.emailFails };
  const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = (init.method || "GET").toUpperCase(), body = init.body ? JSON.parse(init.body) : null;
    w.calls.push({ host: u.host, method, path: u.pathname, auth: init.headers && init.headers.Authorization, body });
    if (u.host === "api.hubapi.com") {
      if (!init.headers.Authorization || init.headers.Authorization !== `Bearer ${TOKEN}`) return J(401, { message: "bad token" });
      if (u.pathname === "/crm/v3/objects/contacts/search") {
        const email = body.filterGroups[0].filters[0].value;
        const hit = w.searchBlind ? null : [...w.contacts.values()].find((c) => c.properties.email === email);
        return J(200, { results: hit ? [hit] : [] });
      }
      if (u.pathname === "/crm/v3/objects/contacts" && method === "POST") {
        if (w.createFails) return J(500, { message: "boom" });
        const dupe = [...w.contacts.values()].find((c) => c.properties.email === body.properties.email);
        if (dupe) return J(409, { status: "error", category: "CONFLICT", message: `Contact already exists. Existing ID: ${dupe.id}` });
        const id = String(w.nextId++); w.contacts.set(id, { id, properties: { ...body.properties } }); return J(201, { id, properties: body.properties });
      }
      if (u.pathname === "/crm/v3/objects/contacts" && method === "GET") return J(200, { results: [] });
      let m = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(u.pathname);
      if (m && method === "PATCH") { const c = w.contacts.get(m[1]); Object.assign(c.properties, body.properties); return J(200, c); }
      if (m && method === "GET") return J(200, w.contacts.get(m[1]));
      if (u.pathname === "/crm/v3/objects/notes" && method === "POST") {
        if (w.noteFails) return J(403, { category: "MISSING_SCOPES" });
        const id = String(w.nextId++); w.notes.push({ id, body: body.properties.hs_note_body, contactId: body.associations[0].to.id, assoc: body.associations[0].types[0].associationTypeId }); return J(201, { id });
      }
      return J(404, {});
    }
    if (u.host === "api.resend.com") {
      if (w.emailFails) return J(422, { message: "domain not verified" });
      w.emails.push({ headers: init.headers, body }); return J(200, { id: "re_" + w.emails.length });
    }
    throw new Error("unexpected outbound call " + url);
  };
  return w;
}
const baseEnv = (extra = {}) => ({ HUBSPOT_ACCESS_TOKEN: TOKEN, ...extra });
const mailEnv = (extra = {}) => baseEnv({ RESEND_API_KEY: "re_secret_key", EMAIL_FROM: "VA Carlo G <notifications@taskforcezsolution.com>", NOTIFY_TO: "carlo.g@taskforcezsolution.com", ...extra });
let ipN = 0;
const post = (env, body, { origin = ORIGIN, type = "application/json", ip, raw } = {}) => worker.fetch(new Request("https://api.test/api/inquiries", { method: "POST", headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": type, "CF-Connecting-IP": ip || `10.0.0.${++ipN}` }, body: raw ?? JSON.stringify(body) }), env);
let G = 0;
const good = (o = {}) => ({ firstName: "Maria", lastName: "Santos", email: `maria${++G}@example.com`, phone: "+63 912 345 6789", company: "Santos Coaching", service: "Website Design", subject: "Quote", message: `I would like a website for my coaching practice (#${G}).`, sourceUrl: "https://vacarlog.taskforcezsolution.com/#contact", page: "FAQs / Contact", ...o });
const j = async (r) => r.json();

console.log("1. Health, routing and CORS");
{
  makeWorld();
  let r = await worker.fetch(new Request("https://api.test/health"), baseEnv()); ok(r.status === 200 && (await j(r)).ok, "GET /health");
  r = await worker.fetch(new Request("https://api.test/nope"), baseEnv()); ok(r.status === 404, "unknown route returns 404");
  r = await worker.fetch(new Request("https://api.test/api/inquiries", { method: "GET" }), baseEnv()); ok(r.status === 405, "GET /api/inquiries returns 405");
  r = await worker.fetch(new Request("https://api.test/api/inquiries", { method: "OPTIONS", headers: { Origin: ORIGIN } }), baseEnv());
  ok(r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === ORIGIN && /POST/.test(r.headers.get("Access-Control-Allow-Methods")), "preflight allowed for the real site origin");
  r = await worker.fetch(new Request("https://api.test/api/inquiries", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), baseEnv());
  ok(r.status === 403 && !r.headers.get("Access-Control-Allow-Origin"), "preflight refused for another origin (no wildcard)");
  r = await worker.fetch(new Request("https://api.test/test-hubspot"), baseEnv()); ok(r.status === 200 && (await j(r)).ok, "GET /test-hubspot is read-only and works");
}

console.log("2. New inquiry creates a contact + note");
{
  const w = makeWorld(); const r = await post(baseEnv(), good({ email: "New.Contact@Example.com" })); const b = await j(r);
  ok(r.status === 200 && b.ok && b.status === "created" && b.contactId, "returns created + contact id", JSON.stringify(b));
  const c = [...w.contacts.values()][0];
  ok(w.contacts.size === 1 && c.properties.email === "new.contact@example.com", "email normalised to lowercase");
  ok(c.properties.firstname === "Maria" && c.properties.lastname === "Santos" && c.properties.phone === "+63 912 345 6789" && c.properties.company === "Santos Coaching", "standard properties stored");
  ok(w.notes.length === 1 && w.notes[0].assoc === 202 && w.notes[0].contactId === b.contactId, "note associated to the contact");
  ok(w.notes[0].body.includes("I would like a website") && w.notes[0].body.includes("Website Design") && w.notes[0].body.includes("#contact"), "note holds message, service and source URL");
  ok(b.notification.status === "not_configured", "email reported honestly as not_configured");
  ok(JSON.stringify(b).indexOf(TOKEN) === -1, "service key never appears in the response");
  ok(w.calls.filter((x) => x.host === "api.hubapi.com").every((x) => x.auth === `Bearer ${TOKEN}`), "service key only sent to HubSpot");
}

console.log("3. Existing contact is updated, never duplicated, blanks never overwrite");
{
  const w = makeWorld(); const env = baseEnv(); const E3 = "repeat.client@example.com";
  await post(env, good({ email: E3, company: "Acme Ltd", phone: "" }));
  const r = await post(env, good({ email: E3, firstName: "Mia", lastName: "S", company: "", phone: "0917 000 1111", message: "Second message about funnels." }));
  const b = await j(r), c = [...w.contacts.values()][0];
  ok(b.status === "updated" && w.contacts.size === 1, "second inquiry updates the same contact (1 contact)");
  ok(c.properties.firstname === "Maria" && c.properties.lastname === "Santos", "existing names are not replaced");
  ok(c.properties.company === "Acme Ltd", "empty company did not overwrite existing value");
  ok(c.properties.phone === "0917 000 1111", "newly supplied phone saved");
  ok(w.notes.length === 2 && w.notes[1].body.includes("Second message"), "each inquiry adds its own note");
}

console.log("4. Race: search misses but HubSpot answers 409 -> falls back to update");
{
  const w = makeWorld({ searchBlind: true }); const env = baseEnv();
  const E4 = "race@example.com"; await post(env, good({ email: E4 })); const r = await post(env, good({ email: E4, message: "Another message here please." })); const b = await j(r);
  ok(r.status === 200 && b.status === "updated" && w.contacts.size === 1, "409 conflict handled without duplicate");
}

console.log("5. Email notification (Resend)");
{
  const E5 = "mail.test@example.com"; let w = makeWorld(); let r = await post(mailEnv(), good({ email: E5, message: "Hello <script>alert(1)</script> & thanks" })); let b = await j(r);
  const mail = w.emails[0];
  ok(b.notification.status === "accepted" && b.notification.providerId, "email accepted by provider (id returned)");
  ok(mail.body.to[0] === "carlo.g@taskforcezsolution.com" && mail.body.reply_to === E5, "sent to the owner, reply-to is the visitor");
  ok(["Maria Santos", E5, "+63 912 345 6789", "Santos Coaching", "Website Design", "FAQs / Contact", b.contactId].every((s) => mail.body.text.includes(s)) && /UTC|Submitted/.test(mail.body.text), "email contains every required field incl. contact id");
  ok(!mail.body.html.includes("<script>") && mail.body.html.includes("&lt;script&gt;"), "visitor text is HTML-escaped in the email");
  ok(mail.headers.Authorization === "Bearer re_secret_key" && JSON.stringify(b).indexOf("re_secret_key") === -1, "email key stays server-side");
  w = makeWorld({ emailFails: true }); r = await post(mailEnv(), good()); b = await j(r);
  ok(r.status === 200 && b.ok && b.notification.status === "failed", "email failure reported, HubSpot success preserved");
}

console.log("6. Note failure does not lose the lead");
{
  const w = makeWorld({ noteFails: true }); const r = await post(mailEnv(), good()); const b = await j(r);
  ok(r.status === 200 && b.ok && b.note.status === "failed" && w.contacts.size === 1 && b.notification.status === "accepted", "contact saved, note failure reported, email still sent");
}

console.log("7. HubSpot failure is reported, owner still alerted by email");
{
  const w = makeWorld({ createFails: true }); const r = await post(mailEnv(), good()); const b = await j(r);
  ok(r.status === 502 && !b.ok && b.error.code === "crm_error", "502 crm_error returned to the browser");
  ok(w.emails.length === 1 && w.emails[0].body.subject.startsWith("[HubSpot NOT saved]"), "backup email flagged 'HubSpot NOT saved'");
  const r2 = await post({}, good()); ok(r2.status === 500 && (await j(r2)).error.code === "server_not_configured", "missing secret -> safe 500, no leak");
}

console.log("8. Validation and abuse protection");
{
  makeWorld();
  const cases = [["missing email", good({ email: "" }), "email"], ["bad email", good({ email: "not-an-email" }), "email"], ["header-injection email", good({ email: "a@b.com\nBcc: x@y.com" }), "email"], ["empty message", good({ message: "  " }), "message"],
    ["bad phone", good({ phone: "abc" }), "phone"], ["missing first name", good({ firstName: "" }), "firstName"], ["message too long", good({ message: "x".repeat(3100) }), "message"]];
  for (const [name, body, field] of cases) { const r = await post(baseEnv(), body); const b = await j(r); ok(r.status === 400 && b.error.code === "validation_error" && b.error.fields[field], `rejects ${name}`, JSON.stringify(b)); }
  let r = await post(baseEnv(), null, { raw: JSON.stringify({ message: "y".repeat(25000) }) }); ok(r.status === 413, "oversized body -> 413");
  r = await post(baseEnv(), good(), { type: "text/plain" }); ok(r.status === 415, "non-JSON content type -> 415");
  r = await post(baseEnv(), null, { raw: "{bad json" }); ok(r.status === 400, "invalid JSON -> 400");
  r = await post(baseEnv(), good(), { origin: "https://evil.example" }); ok(r.status === 403, "foreign origin refused");
  r = await post(baseEnv(), good(), { origin: null }); ok(r.status === 403, "missing Origin refused");
  const w = makeWorld(); r = await post(baseEnv(), good({ website: "http://spam.example" })); const b = await j(r);
  ok(r.status === 200 && w.calls.length === 0 && b.status === "received", "honeypot: fake success, nothing sent to HubSpot");
  const w2 = makeWorld(); const env = baseEnv(); let last;
  for (let i = 0; i < 9; i++) last = await post(env, good({ email: `u${i}@example.com`, message: `Message number ${i} here` }), { ip: "203.0.113.9" });
  ok(last.status === 429, "9th request from one IP within 10 minutes -> 429");
}

console.log("9. Duplicate submissions");
{
  let w = makeWorld(); const env = baseEnv(); const body = good({ idempotencyKey: "abc12345-xyz" });
  const a = await post(env, body), c = await post(env, body), cb = await j(c);
  ok(cb.duplicate === true && w.notes.length === 1, "same idempotency key -> no second note");
  w = makeWorld(); const same = good({ email: "x1@example.com" }); await post(env, same); const d = await post(env, same); ok((await j(d)).duplicate === true && w.notes.length === 1, "identical resubmission (no key) is detected");
  w = makeWorld({ createFails: true }); const bad = good({ email: "retry@example.com", idempotencyKey: "retry-key-0001" }); await post(env, bad); w.createFails = false;
  const again = await post(env, bad); ok((await j(again)).status === "created", "a failed attempt can be retried with the same key");
}

console.log("10. Tally webhook");
{
  const secret = "tally-signing-secret";
  const evt = { eventId: "e1", eventType: "FORM_RESPONSE", createdAt: "2026-11-15T01:00:00Z", data: { responseId: "r1", submissionId: "s1", formId: "o9evD1", formName: "Contact", fields: [
    { key: "q1", label: "Name", type: "INPUT_TEXT", value: "Juan Dela Cruz" }, { key: "q2", label: "Email", type: "INPUT_EMAIL", value: "juan@example.com" }, { key: "q3", label: "Phone", type: "INPUT_PHONE_NUMBER", value: "+63 917 111 2222" },
    { key: "q4", label: "Company", type: "INPUT_TEXT", value: "JDC" }, { key: "q5", label: "How can I help?", type: "TEXTAREA", value: "I need an eBook." }, { key: "q6", label: "service", type: "HIDDEN_FIELDS", value: "eBook Writing & Design" }] } };
  const raw = JSON.stringify(evt), sig = createHmac("sha256", secret).update(raw).digest("base64");
  const hook = (env, body, signature) => worker.fetch(new Request("https://api.test/api/tally-webhook", { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "tally-signature": signature } : {}) }, body }), env);
  makeWorld(); let r = await hook(baseEnv(), raw, sig); ok(r.status === 503, "refuses to run until TALLY_SIGNING_SECRET is set");
  r = await hook(baseEnv({ TALLY_SIGNING_SECRET: secret }), raw, "wrong"); ok(r.status === 401, "bad signature -> 401");
  const w = makeWorld(); const env = baseEnv({ TALLY_SIGNING_SECRET: secret });
  r = await hook(env, raw, sig); let b = await j(r); const c = [...w.contacts.values()][0];
  ok(r.status === 200 && b.status === "created" && c.properties.firstname === "Juan" && c.properties.lastname === "Dela Cruz" && c.properties.email === "juan@example.com" && c.properties.phone === "+63 917 111 2222", "valid Tally response creates a mapped contact");
  ok(w.notes[0].body.includes("Tally form inquiry") && w.notes[0].body.includes("eBook Writing") && w.notes[0].body.includes("I need an eBook"), "note records the Tally answers and service");
  r = await hook(env, raw, sig); ok((await j(r)).duplicate === true && w.notes.length === 1, "Tally retry/replay of the same submission is ignored");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
