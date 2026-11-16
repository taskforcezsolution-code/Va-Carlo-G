# VA Carlo G: HubSpot CRM integration (deployment and testing guide)

## 1. What I found in the existing site
| Item | Finding |
|---|---|
| Contact form | None on the site. The Contact page showed a Tally embed. An old `mailto:` form (`#cf`) and an empty `FORM_ENDPOINT` were dead code that never rendered. |
| Service inquiry forms | Every "Get a quote / audit" button opens your Tally form (`https://tally.so/r/o9evD1?service=...`). No form code on the site. |
| Booking | Calendly (not an inquiry form, unchanged). |
| Existing Worker | `https://va-carlo-crm-api.taskforcezsolution.workers.dev`. I could not call it from my environment (the base URL returned a client error, consistent with it having only the 3 routes you listed), so I wrote the new Worker from your description. **I have not seen your current Worker code.** |

## 2. What changed
**Frontend (upload to the repo, same folders)**
- `assets/js/app.js`: new shared pipeline (`submitInquiry`, `validateInquiry`, `inquiryForm`, `bindInquiryForms`); Contact page now shows a native form instead of the Tally embed; dead `mailto`/`FORM_ENDPOINT` logic removed; fixed a latent error on FAQ chip clicks; `EMAIL` is now `carlo.g@taskforcezsolution.com`.
- `assets/css/site.css`: form styling in your palette (light and dark).
- `privacy-policy.html`: now mentions HubSpot, Cloudflare and the email provider.

**Backend (new, for review before deploying)**
- `worker/index.js`: complete Worker. Routes: `GET /health`, `GET /test-hubspot` (read-only), `POST /api/inquiries`, `POST /api/tally-webhook` (optional).
- `worker/wrangler.toml`: example config. `worker/test/run-tests.mjs`: offline test suite.
- **`POST /test-create-contact` is intentionally not included.** It is an unauthenticated route that creates contacts, which anyone could abuse. If you want to keep it, paste your old handler back in, but I recommend removing it.

Not touched: design, navigation, dashboard, GitHub structure, Cloudflare hosting, DNS, domain.

## 3. What the production endpoint does
`POST /api/inquiries`: restricts CORS to `https://vacarlog.taskforcezsolution.com` (no wildcard; OPTIONS handled), requires JSON, 20 KB size limit, validates and sanitises everything on the server, honeypot, rate limit (8 per IP per 10 min per Worker instance; Cloudflare rate-limit binding supported), duplicate protection (idempotency key or content hash; KV optional).
Then: search HubSpot by email → update the existing contact or create one (409 race handled) → add a **note** with the message, service and source → email notification → structured JSON.
- Existing contact: first/last name are never replaced; phone and company are updated only when the visitor provides a value; blank values never overwrite.
- Service of interest and source URL are stored in the note (creating custom contact properties would need an extra HubSpot permission).
- Responses report `contact` status, `note` status and `notification` status separately. Email status is `not_configured`, `accepted` (provider returned an id) or `failed`. `accepted` means the provider took the message; delivery itself is visible in the provider's dashboard.
- If HubSpot fails, the visitor gets an error and you receive a backup email marked **[HubSpot NOT saved]**, so the lead is not lost.

## 4. Secrets and configuration
| Name | Type | Required | Notes |
|---|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | secret | yes | already set |
| `RESEND_API_KEY` | secret | for email | from resend.com |
| `EMAIL_FROM` | variable | for email | e.g. `VA Carlo G <notifications@taskforcezsolution.com>`; the domain must be verified in Resend |
| `NOTIFY_TO` | variable | no | defaults to `carlo.g@taskforcezsolution.com` |
| `ALLOWED_ORIGINS` | variable | no | defaults to `https://vacarlog.taskforcezsolution.com`; comma-separate extra origins (for example a `*.pages.dev` preview) |
| `INQUIRY_KV` | KV binding | recommended | duplicate protection across instances |
| `TALLY_SIGNING_SECRET` | secret | only for Tally webhook | |

HubSpot permissions: contacts read/write are enough for contacts. Notes use HubSpot's Notes API; if note creation returns `note.status: "failed"` with code `hubspot_auth`, add the permission for notes/engagements to your Service Key. The contact is still saved either way.

## 5. Deploy
1. Cloudflare dashboard → Workers & Pages → `va-carlo-crm-api` → Edit code. Replace with `worker/index.js`. **Keep a copy of your current code first.**
2. Settings → Variables and Secrets: add the items in section 4.
3. (Optional) Resend: add and verify `taskforcezsolution.com` (you add the DNS records Resend shows; I did not touch DNS), create an API key.
4. Deploy. Check `…/health` and `…/test-hubspot`.
5. Upload the frontend files to GitHub (`assets/js/app.js`, `assets/css/site.css`, `privacy-policy.html`). Hard-refresh.
6. Optional: In Cloudflare add a Rate Limiting rule for `/api/inquiries` (for example 10 per minute per IP).

## 6. Test it for real (do these before relying on it)
Run in a terminal (Origin header is required; the real site sends it automatically):
```
curl -i -X POST https://va-carlo-crm-api.taskforcezsolution.workers.dev/api/inquiries \
 -H "Origin: https://vacarlog.taskforcezsolution.com" -H "Content-Type: application/json" \
 -d '{"firstName":"Test","lastName":"Visitor","email":"your-test-address@example.com","phone":"+63 900 000 0000","company":"Test Co","service":"Website Design","message":"Testing the new CRM form."}'
```
1. **New contact**: expect `"status":"created"` and a `contactId`; in HubSpot, find the contact and open its activity: a note with the message.
2. **Existing contact**: send it again with the same email and a different message and company. Expect `"status":"updated"`, still **one** contact, **two** notes, existing name unchanged.
3. **Message recorded**: confirm `"note":{"status":"created"}` and the note text in HubSpot.
4. **Email**: expect `"notification":{"status":"accepted"}`; check the inbox for carlo.g@ and the Resend dashboard (Emails) for "Delivered". If it says `not_configured`, steps 3 of section 5 are not done yet.
5. **Frontend**: open the Contact page, submit the form, confirm the "Thank you" panel; also try an empty form, an invalid email, and (in DevTools → Network → Offline) a network failure.
6. Wrong origin: add `-H "Origin: https://evil.example"` and expect `403`.

### Tally forms (optional; the quote/audit buttons still open Tally)
To also send those submissions to HubSpot: Tally → form `o9evD1` → Integrations → Webhooks → endpoint `https://va-carlo-crm-api.taskforcezsolution.workers.dev/api/tally-webhook`, set a signing secret and add the same value as `TALLY_SIGNING_SECRET`. The Worker maps fields by type and label (email, phone, name, company, message, hidden field `service`). **Verify with one real test submission**, since your form's exact labels were not visible to me.

## 7. Verification status
| Requirement | Status |
|---|---|
| 1. New inquiry creates a HubSpot contact | Logic verified against a **simulated** HubSpot (52 offline tests pass). **Not yet confirmed against your real HubSpot.** |
| 2. Existing contact updated without duplication | Same: simulated only. |
| 3. Inquiry message recorded | Simulated only. Real run depends on the Service Key's note permission. |
| 4. Email delivery confirmed | **Not confirmed.** Needs Resend set up. The Worker only reports `accepted` when the provider returns an id. |
| 5. Frontend shows correct status | Verified in a real browser with the API simulated (19 checks: validation, sending state, double-submit block, success, 400/429/5xx/offline, retry key). |

Run offline tests any time: `node worker/test/run-tests.mjs` (Node 20+).
