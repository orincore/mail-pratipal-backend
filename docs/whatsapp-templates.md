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
