# WhatsApp Notification Templates (MSG91 WhatsApp Cloud API)

All templates below are **Category: UTILITY**. None are Marketing — no promotional
language, no offers/discounts, no emojis beyond what's listed, no exclamation-heavy
tone. Each is tied to a specific transaction the recipient already opted into
(webinar registration), which is what qualifies them for Utility approval.

Language: English (`en`) unless a Hindi variant is separately approved later.

Join-link button base URL (all templates that use it):
```
https://pratipal.in/webinar/join/{{1}}
```
`{{1}}` = the `Webinar._id` / `InvitationWindow._id` (same ObjectId, since
`Webinar.source_window_id` mirrors it). This is a **fixed base URL with one dynamic
suffix** — WhatsApp only allows the suffix to vary, not the whole URL, which is why
Zoom/Google Meet/Teams links (different domains) are never placed directly in the
button. The redirect route lives at
`Pratipal Website/src/app/webinar/join/[windowId]/route.ts` and resolves
`InvitationWindow.join_link` server-side.

---

## 1. `webinar_registration_confirmation`

**Trigger:** immediately after signup, replacing/augmenting the current email-only
confirmation (`Pratipal Website/src/app/api/invitations/route.ts`).

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

## 2. `webinar_reminder`

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

**Buttons:** 1 URL button — **"Join Webinar"** → dynamic URL, suffix `{{1}}` = `Webinar._id`

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

**Buttons:** 1 URL button — **"Join Webinar"** → dynamic URL, suffix `{{1}}` = `Webinar._id`

> Note: this template's own body variables are `{{1}}`/`{{2}}` (name, title). The
> button's `{{1}}` is a **separate placeholder scoped to the button component** —
> MSG91/Meta number body and button variables independently, so both start at
> `{{1}}` in their own component.

---

## 4. `webinar_cancelled`

**Trigger:** admin sets a webinar's status to `cancelled`. Not yet wired up in code
— today `mail-pratipal-backend/src/routes/webinars.ts` only cascades to skip
pending reminders; this notice needs to be added alongside the WhatsApp send.

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

**Trigger:** admin changes `Webinar.starts_at` on an existing webinar. Not yet
wired up — today `webinar-sync.ts` silently re-times pending reminders with no
notice sent.

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

## Implementation notes for whoever wires up the MSG91 provider

- Each `WebinarReminder`-equivalent row needs a `channel` (`email` | `whatsapp`)
  and a `template_name` matching the approved MSG91 template exactly (template
  names above are the intended slugs — confirm they match what's actually
  approved before hardcoding).
- Reuse the existing sweep in `queue-processor.ts` (`processWebinarReminders`) /
  claiming pattern (`dispatch_status: pending → sending → sent`) rather than
  building a second poller.
- `Webinar.join_link` / `Webinar.join_platform` are mirrored from
  `InvitationWindow` via `syncWebinarsFromWebsite()` — read from there, don't
  refetch from the website per send.
