# WhatsApp Notification Templates (MSG91 WhatsApp Cloud API)

All templates below are **Category: UTILITY**. None are Marketing — no promotional
language, no offers/discounts, no emojis beyond what's listed, no exclamation-heavy
tone. Each is tied to a specific transaction the recipient already opted into
(webinar registration), which is what qualifies them for Utility approval.

All seven templates are approved in MSG91 and wired up in code — every
`WhatsappTemplateName` in `src/lib/whatsapp-templates.ts` now maps to a real,
live send. `WHATSAPP_TEMPLATES`/`DEFAULT_WHATSAPP_TEMPLATE_FOR_PRESET` point
reminder presets at their specific template (not the `event_notify` generic
fallback, which is still selectable manually but is no longer any preset's
default).

Language: English (`en`) unless a Hindi variant is separately approved later.

**Join-link button — restored to dynamic, pending MSG91/Meta approval.** The
"Join Webinar" button on `webinar_starting_soon`/`webinar_live_now` was
previously switched in MSG91 from a dynamic URL (base + `{{1}}` suffix) to a
fully static URL, as a fix for an earlier bug where the literal text `{{1}}`
was leaking into the sent link (someone had pasted the dynamic-URL example
into the button's URL field as plain text instead of configuring it as a
variable). That masked the real problem instead of fixing it: every
recipient, for every webinar, got the exact same fixed URL.

`buildWhatsappTemplateParams()` now returns `buttonUrlSuffix: joinSuffix`
(`Webinar._id`) for both templates again — **but this requires the button in
MSG91 to actually be reconfigured as a Dynamic URL and re-approved by Meta
first**, or every send of these two templates will be rejected outright (a
filled parameter on a template whose button has no variable slot is an
invalid send). Steps in MSG91:
1. Edit `webinar_starting_soon` / `webinar_live_now`, change the "Join
   Webinar" button from Static URL to Dynamic URL.
2. Base URL: `https://pratipal.in/webinar/join/` — let MSG91's own UI
   generate the `{{1}}` placeholder; do not type `{{1}}` into the field
   yourself, that's exactly what caused the original bug.
3. Submit for Meta re-approval and confirm it's live before relying on these
   sends in production.

If the button is ever reverted to fully static again, remove
`buttonUrlSuffix` from those two cases in `buildWhatsappTemplateParams()`
(see the comment there).

Email does not have this limitation — the "Join Webinar Session" button in
the Webinar Reminder email template uses the `{{join_link}}` merge tag
(`EmailSubscriber.metadata.webinar_join_link`, set per-registrant in
`syncRegistrantsForWebinar()`), so it always points at the correct
`https://pratipal.in/webinar/join/<Webinar._id>` redirect for that person's
occurrence. The redirect route lives at
`Pratipal Website/src/app/webinar/join/[windowId]/route.ts` and resolves
`InvitationWindow.join_link` server-side.

---

## 1. `webinar_registration_confirmation`

**Trigger:** `syncRegistrantsForWebinar()` in `src/lib/webinar-sync.ts` — fired the
first time a registrant's email gets `webinarTag(webinar)` added (i.e. genuinely
new to *this occurrence*, even if they're an existing `EmailSubscriber` from an
earlier run of the same webinar). Since registrant sync is polled (throttled to
once per 5 min per webinar, driven by the worker's 10s loop), this lands within
~5 minutes of signup, not instantly — it augments the website's existing
email-only confirmation (`Pratipal Website/src/app/api/invitations/route.ts`),
which still fires immediately and is unchanged.

**Body:**
```
Hi {{1}}, your seat for *{{2}}* is confirmed. It's scheduled on {{3}} at {{4}} ({{5}}). We'll send you the joining link and reminders here on WhatsApp.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | `InvitationRequest.first_name` |
| `{{2}}` | Webinar title | `Webinar.title` |
| `{{3}}` | Date | `Webinar.starts_at` formatted in `Webinar.timezone`, date part |
| `{{4}}` | Time | `Webinar.starts_at` formatted in `Webinar.timezone`, time part |
| `{{5}}` | Timezone label | `Webinar.timezone` |

**Buttons:** none

---

## 2. `webinar_remind`

**Trigger:** reused for the `3_days_before` / `2_days_before` / `1_day_before`
presets and any custom day/hour offset in `WebinarReminder`. Only the relative-time
phrase (`{{3}}`) changes between sends — do not create a separate template per
offset.

**Body:**
```
Hi {{1}}, this is a reminder that *{{2}}* is happening {{3}}, on {{4}} at {{5}} ({{6}}). We'll share the joining link closer to the start time.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | `EmailSubscriber.first_name` (or registrant record) |
| `{{2}}` | Webinar title | `Webinar.title` |
| `{{3}}` | Relative time phrase | derived from `WebinarReminder.offset_type`/`offset_value` (e.g. `"in 3 days"`, `"tomorrow"`, `"in 2 days"`) |
| `{{4}}` | Date | `Webinar.starts_at` in `Webinar.timezone` |
| `{{5}}` | Time | `Webinar.starts_at` in `Webinar.timezone` |
| `{{6}}` | Timezone label | `Webinar.timezone` |

**Buttons:** none

---

## 3a. `webinar_starting_soon`

**Trigger:** the `30_min_before` preset offset.

**Body:**
```
Hi {{1}}, your webinar *{{2}}* is starting in 30 minutes. Tap the button below to join when you're ready.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | registrant record |
| `{{2}}` | Webinar title | `Webinar.title` |

**Buttons:** 1 URL button — **"Join Webinar"** → dynamic URL, `https://pratipal.in/webinar/join/<Webinar._id>` (per-recipient — requires the MSG91 button to be configured as Dynamic URL and Meta-approved, see the note above the template list)

---

## 3b. `webinar_live_now`

**Trigger:** the `at_start` preset offset.

**Body:**
```
Hi {{1}}, your webinar *{{2}}* is starting now. Tap the button below to join right away.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | registrant record |
| `{{2}}` | Webinar title | `Webinar.title` |

**Buttons:** 1 URL button — **"Join Webinar"** → dynamic URL, `https://pratipal.in/webinar/join/<Webinar._id>` (per-recipient — requires the MSG91 button to be configured as Dynamic URL and Meta-approved, see the note above the template list)

---

## 4. `webinar_cancelled`

**Trigger:** `PUT /api/webinars/:id` (`src/routes/webinars.ts`) when an admin sets
a webinar's status to `cancelled` — sent immediately, synchronously, to every
`EmailSubscriber` tagged for that occurrence with a `whatsapp_number` on file.
Also cascades both `dispatch_status` and `whatsapp_dispatch_status` on that
webinar's pending reminders to `skipped` (the reminder sweep already skips
whatsapp legs defensively for a cancelled webinar too — this just makes the DB
reflect it immediately rather than only once/if a reminder becomes due).

**Body:**
```
Hi {{1}}, *{{2}}* scheduled on {{3}} has been cancelled. We're sorry for the inconvenience. Reach out to us at connect@pratipal.in for any questions.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | registrant record |
| `{{2}}` | Webinar title | `Webinar.title` |
| `{{3}}` | Original date | `Webinar.starts_at` (pre-cancellation value) in `Webinar.timezone` |

**Buttons:** none

---

## 5. `webinar_rescheduled`

**Trigger:** `syncWebinarsFromWebsite()` in `src/lib/webinar-sync.ts`, when a poll
sees the website's `starts_at` for a webinar it already knew about has changed
(never fires on first sync of a brand-new webinar). Re-times pending reminders'
`computed_send_at` same as before, and — only while the webinar is still
`upcoming` — sends this notice to every tagged subscriber with a
`whatsapp_number`. Self-limits to one send per actual change: the comparison is
against the value already persisted from the previous sync, so once this run
updates it, the next poll sees no change.

**Body:**
```
Hi {{1}}, *{{2}}* has been rescheduled to {{3}} at {{4}} ({{5}}). Your registration remains confirmed — no action needed.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | registrant record |
| `{{2}}` | Webinar title | `Webinar.title` |
| `{{3}}` | New date | new `Webinar.starts_at` in `Webinar.timezone` |
| `{{4}}` | New time | new `Webinar.starts_at` in `Webinar.timezone` |
| `{{5}}` | Timezone label | `Webinar.timezone` |

**Buttons:** none

---

## Recipient phone number

`whatsapp_number` is captured on the signup form (`InvitationRequest.whatsapp_number`)
and normalized/persisted into `EmailSubscriber.whatsapp_number` by
`normalizeWhatsappNumber()` in `mail-pratipal-backend/src/lib/webinar-sync.ts`
(defaults bare 10-digit numbers to `+91`). Use `EmailSubscriber.whatsapp_number` as
the send-to number — do not query the website directly for this at send time.

## Implementation status

All done. For reference, where each piece lives:

- Reminders (3-day/2-day/1-day/30-min/at-start) dispatch through the existing
  sweep in `queue-processor.ts` (`processWebinarReminders` →
  `sendWhatsappLegForReminder`), claimed via the same
  `whatsapp_dispatch_status: pending → sending → sent` pattern the email leg
  uses — no second poller.
- Registration confirmation, cancellation, and reschedule notices are
  one-shot sends (not `WebinarReminder` rows) fired directly from
  `webinar-sync.ts` / `routes/webinars.ts` via the shared
  `sendLifecycleWhatsapp()` helper — see each template's Trigger note above.
- `Webinar.join_link` / `Webinar.join_platform` are mirrored from
  `InvitationWindow` via `syncWebinarsFromWebsite()` — read from there, never
  refetched from the website per send.
- Template names in code (`WhatsappTemplateName` in
  `src/lib/whatsapp-templates.ts`) match the slugs in this doc exactly — keep
  both in lockstep if a template is ever renamed in MSG91.

---

# Transactional Templates (Orders, E-Books, Bookings, Invitations)

These 8 templates power `POST /api/notifications/whatsapp/send`
(`src/routes/notifications.ts`), called directly by **Pratipal Website** for
its own transactional events — separate from the webinar lifecycle above.
Defined in `src/lib/notification-templates.ts`
(`TransactionalWhatsappEvent` / `buildTransactionalWhatsappParams`), which is
intentionally kept apart from `whatsapp-templates.ts` since the data shape
(order/booking fields) doesn't fit the webinar-specific
`WhatsappTemplateData` interface.

Same rules as above: **Category: UTILITY**, factual/non-promotional tone,
language `en`. Each is tied to a transaction the recipient just completed
(order placed, e-book purchased, session booked, form submitted) — the
qualifying basis for Utility approval. **The template name in MSG91 must be
created with the exact event name below** (they're used 1:1 as the MSG91
template name — no separate mapping).

Two templates (`order_confirmed_customer`, `order_status_update_customer`)
share the same button target (`/track/<orderNumber>`); one
(`ebook_delivered_customer`) points at a different stable redirect
(`/api/download/<orderItemId>`). Both redirect routes live in Pratipal
Website and resolve the real destination (tracking page / signed download
URL) server-side, so the approved template's URL never needs to change even
if the underlying page or file-hosting details do — same pattern as the
`webinar/join/[windowId]` redirect above.

---

## 6. `invitation_registration_confirmed`

**Trigger:** `POST /api/invitations` (`Pratipal Website/src/app/api/invitations/route.ts`)
— fired instantly on landing-page/invitation form submit, customer-facing
only. Replaces the admin notification **email** for this flow, which has
been removed (the admin can still see submissions in
`/admin/landing-pages/.../invitations`).

**Body:**
```
Hi {{1}}, thanks for registering for *{{2}}*! We've received your details and will reach out here on WhatsApp with everything you need to know. If you have any questions, feel free to reply to this message.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | First name | `InvitationRequest.first_name` |
| `{{2}}` | Topic/session title | Landing page `title` (falls back to `"your session"` if unavailable) |

**Buttons:** none

---

## 7. `order_confirmed_customer`

**Trigger:** order placed and payment verified (`POST
/api/razorpay/verify-payment`), customer-facing. All Pratipal orders are
prepaid via Razorpay — there is no COD option in checkout — so the template
doesn't carry a payment-method variable. (`POST /api/orders`'s COD branch
also fires this same event/shape for parity if a COD order is ever created
by some future/manual path, but that branch is not reachable from the
current checkout UI.)

**Body:**
```
Hi {{1}}, your order *{{2}}* has been confirmed! Items: {{3}}. Total paid: *₹{{4}}*. Tap below to track your order status anytime.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Customer name | `Order.customer_name` |
| `{{2}}` | Order number | `Order.order_number` |
| `{{3}}` | Itemized list | `formatOrderItemsForWhatsapp(orderItems)` (`Pratipal Website/src/lib/whatsapp.ts`) — e.g. `"Rose Quartz Crystal x2 (₹998.00), Lavender Essential Oil x1 (₹299.00)"`. Comma-separated, no newlines (Meta rejects newlines/tabs/4+ spaces in template parameter values); truncates with "+N more items" if the rendered body would exceed a safe length. |
| `{{4}}` | Total | `Order.total`, 2dp |

**Buttons:** 1 URL button — **"Track Order"** → dynamic URL, base
`https://pratipal.in/track/`, suffix = `Order.order_number` (requires the
button to be configured as Dynamic URL in MSG91, see the Join-link note
above for the exact steps)

---

## 8. `order_confirmed_admin`

**Trigger:** same as #7, admin-facing, sent to `ADMIN_WHATSAPP_NUMBER`.

**Body:**
```
New order *{{1}}* received from {{2}} ({{3}}). Items: {{4}}. Total: *₹{{5}}* (paid). Please review and process it in the admin dashboard.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Order number | `Order.order_number` |
| `{{2}}` | Customer name | `Order.customer_name` |
| `{{3}}` | Customer phone | `shipping_address.phone` → `Customer.phone` fallback, `"—"` if none |
| `{{4}}` | Itemized list | same `formatOrderItemsForWhatsapp()` output as #7 |
| `{{5}}` | Total | `Order.total`, 2dp |

**Buttons:** none

---

## 9. `order_status_update_customer`

**Trigger:** `PATCH /api/admin/orders/[id]` when `tracking_status` changes
(admin updates shipping status), customer-facing.

**Body:**
```
Hi {{1}}, your order *{{2}}* status has been updated to *{{3}}*. Tap below for full tracking details.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Customer name | `Order.customer_name` |
| `{{2}}` | Order number | `Order.order_number` |
| `{{3}}` | Status label | `Order.tracking_status` (e.g. `"shipped"`, `"out_for_delivery"`, `"delivered"`) |

**Buttons:** 1 URL button — **"Track Order"** → same dynamic URL as #7

---

## 10. `ebook_delivered_customer`

**Trigger:** `POST /api/razorpay/verify-payment`, once per e-book
`OrderItem` successfully emailed (fires right after the existing
awaited e-book delivery email), customer-facing.

**Body:**
```
Hi {{1}}, your e-book *{{2}}* from order *{{3}}* is ready! Tap the button below to download your copy.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Customer name | `Order.customer_name` |
| `{{2}}` | Product name | `OrderItem.product_name` |
| `{{3}}` | Order number | `Order.order_number` |

**Buttons:** 1 URL button — **"Download E-Book"** → dynamic URL, base
`https://pratipal.in/api/download/`, suffix = `OrderItem._id` (the redirect
route resolves the actual, possibly-signed `ebook_download_url`
server-side, so the button's approved URL never has to embed a fragile
signed link with query params)

---

## 11. `ebook_sold_admin`

**Trigger:** same as #10, admin-facing.

**Note:** originally 5 separate variables — Meta rejected it ("This template
has too many variables for its length"). Consolidated into 3, with more
surrounding static text, per Meta's variable-density guidance.

**Body:**
```
An e-book purchase has been completed on Pratipal. Product & order: {{1}}. Buyer: {{2}}. Amount paid: *₹{{3}}*. You can view the full order details in the admin dashboard.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Product & order | `"${OrderItem.product_name} — Order ${Order.order_number}"`, built at the call site |
| `{{2}}` | Buyer | `"${Order.customer_name} (${Order.customer_email})"`, built at the call site |
| `{{3}}` | Amount | `OrderItem.subtotal`, 2dp |

**Buttons:** none

---

## 12. `booking_confirmed_customer`

**Trigger:** `POST /api/bookings/verify-payment` (course or consultation
session booking payment verified), customer-facing. Covers both
`SessionBooking.order_type` values (`"course"` and `"service"`) via the
`{{2}}` label rather than two separate templates.

**Note:** originally 6 separate variables — Meta rejected it for the same
too-many-variables reason as #11. Consolidated booking number/service/plan
into one variable and lengthened the surrounding text.

**Body:**
```
Hi {{1}}, great news — your {{2}} booking with Pratipal is confirmed! {{3}}. Amount paid: *₹{{4}}*. Our team will reach out to you here on WhatsApp shortly to schedule your session. Thank you for choosing us.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Customer name | `SessionBooking.customer_name` |
| `{{2}}` | Session type label | `"Course"` / `"Consultation"` from `order_type` |
| `{{3}}` | Booking summary | `"Booking #${booking_number} — ${service_name} (${frequency_label} plan)"`, built at the call site |
| `{{4}}` | Amount | `SessionBooking.amount`, 2dp |

**Buttons:** none

---

## 13. `booking_confirmed_admin`

**Trigger:** same as #12, admin-facing.

**Note:** originally 7 separate variables — the most severe case of Meta's
too-many-variables rejection. Consolidated to 4.

**Body:**
```
A new {{1}} booking has been received on Pratipal. {{2}}. Customer: {{3}}. Amount paid: *₹{{4}}*. Please reach out to the customer to schedule their session and update the booking status in the admin dashboard.
```

| Var | Meaning | Source |
|---|---|---|
| `{{1}}` | Session type label | same as #12 |
| `{{2}}` | Booking summary | same composite as #12's `{{3}}` |
| `{{3}}` | Customer | `"${customer_name} (${customer_whatsapp \|\| customer_phone})"`, built at the call site |
| `{{4}}` | Amount | `SessionBooking.amount`, 2dp |

**Buttons:** none

---

## Transactional recipient phone numbers

Unlike the webinar flow (which reads from `EmailSubscriber.whatsapp_number`,
normalized at ingest time), these events send `to` as a raw string from
Pratipal Website's own data — `InvitationRequest.whatsapp_number`,
`SessionBooking.customer_whatsapp`/`customer_phone`, or
`Order.shipping_address.phone`/`Customer.phone`. `POST
/api/notifications/whatsapp/send` normalizes it via the shared
`normalizeWhatsappNumber()` (`src/lib/phone.ts`) before sending — the website
does not need to normalize before calling. If no usable number resolves for
an order, the website skips the send (logs only) rather than erroring the
checkout.

## Transactional implementation status

- Route: `POST /api/notifications/whatsapp/send` (`src/routes/notifications.ts`),
  protected by the same `authMiddleware` / shared `API_KEY` as
  `/api/test-send/whatsapp`.
- Website caller: `Pratipal Website/src/lib/whatsapp.ts`
  (`sendWhatsappNotification()`) — fire-and-forget with an 8s timeout, never
  throws, so a WhatsApp/MSG91 outage never blocks checkout, booking, or
  registration. Existing email sends are unchanged/kept as the primary
  channel; WhatsApp is additive everywhere except the invitation-form admin
  notice, which the email was removed for.
- All 8 template names above must be created in MSG91 and Meta-approved
  before any of these sends will actually succeed — until then, the route
  will return `{ success: false, error: ... }` per-call, which the website
  already treats as best-effort and ignores.
