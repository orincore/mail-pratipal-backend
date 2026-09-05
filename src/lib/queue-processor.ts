import EmailSubscriber from "../models/EmailSubscriber";
import EmailCampaign from "../models/EmailCampaign";
import EmailTemplate from "../models/EmailTemplate";
import EmailEvent from "../models/EmailEvent";
import Segment from "../models/Segment";
import Webinar from "../models/Webinar";
import { getEmailProvider } from "../providers/provider-factory";
import {
  prepareEmailHtml,
  replaceMergeTags,
  buildListUnsubscribeHeaders,
  TrackingSource,
} from "./tracking-parser";
import { buildSubscriberQueryForSegment } from "./segment-query";
import { sendEmailThrottled, getDailyQuotaRemaining, isTransientSendError } from "./send-throttle";
import { webinarTag } from "./webinar-sync";
import { config } from "../config";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams, type WhatsappTemplateName } from "./whatsapp-templates";

const BATCH_LIMIT = 50;

/**
 * Executes a full queue processing sweep. Webinar reminders no longer go
 * through this sweep — they're dispatched via BullMQ delayed jobs (see
 * src/lib/queue/) for exact-time firing and rate-limited fan-out. This sweep
 * now only handles campaigns; it's driven by POST /api/jobs/process (a
 * deployed cron) or the standalone campaigns-only src/scripts/worker.ts.
 */
export async function runQueueSweep(trackingUrl: string) {
  const provider = getEmailProvider();

  const campaignResults = await processCampaigns(provider, trackingUrl);

  return {
    campaigns: campaignResults,
  };
}

// ==========================================================================
// Audience + A/B helpers
// ==========================================================================

/**
 * Resolves a campaign's audience definition to the list of currently
 * eligible recipients for the given channel. Supports "all", lists/tags
 * matching, and saved segments.
 *
 * `status` ("subscribed"/"unsubscribed"/"bounced"/"complained") is an EMAIL
 * deliverability/consent flag set by email-specific events (unsubscribe link,
 * SES bounce/complaint webhook) — it has no bearing on WhatsApp, so only the
 * email leg filters on it. Gating WhatsApp on it too used to silently drop
 * anyone who'd ever unsubscribed/bounced/complained on an unrelated past
 * email from receiving WhatsApp sends they were otherwise eligible for.
 */
async function resolveAudienceSubscribers(
  audience: any,
  channel: "email" | "whatsapp"
): Promise<any[] | null> {
  // WhatsApp's own opt-out signal (replied "STOP" — see routes/whatsapp.ts's
  // POST /webhook), kept separate from the email `status` field for the same
  // reason `status` itself isn't reused here — see the comment above.
  const baseQuery: any = channel === "email" ? { status: "subscribed" } : { whatsapp_opted_out: { $ne: true } };

  // Webinar audience — one/several specific occurrences, or every webinar's
  // registrants at once. Resolved from the tags syncRegistrantsForWebinar
  // (webinar-sync.ts) already maintains, so this needs nothing new tracked
  // per-subscriber beyond what registrant sync was already doing.
  if (audience?.webinar_all || audience?.webinar_ids?.length > 0) {
    const webinarQuery = audience.webinar_all ? {} : { _id: { $in: audience.webinar_ids } };
    const webinars = await Webinar.find(webinarQuery).select("source_window_id");
    if (webinars.length === 0) return null;
    const tags = webinars.map((w: any) => webinarTag(w));

    // "Registered between" only makes sense pinned to exactly one webinar —
    // across several occurrences a single date range is ambiguous, so it's
    // silently ignored rather than guessing which webinar it was meant for
    // (the wizard UI itself only ever offers the date fields for one).
    if (tags.length === 1 && (audience.webinar_registered_from || audience.webinar_registered_to)) {
      const dateQuery: any = {};
      if (audience.webinar_registered_from) dateQuery.$gte = new Date(audience.webinar_registered_from);
      if (audience.webinar_registered_to) dateQuery.$lte = new Date(audience.webinar_registered_to);
      return EmailSubscriber.find({
        ...baseQuery,
        tags: tags[0],
        [`metadata.registered_at:${tags[0]}`]: dateQuery,
      });
    }

    return EmailSubscriber.find({ ...baseQuery, tags: { $in: tags } });
  }

  if (audience?.segment_id) {
    const segment = await Segment.findById(audience.segment_id);
    if (!segment) {
      // Segment was deleted after the campaign was created — treat as empty
      // audience rather than falling back to blasting everyone.
      return null;
    }
    const segmentQuery = await buildSubscriberQueryForSegment(segment);
    return EmailSubscriber.find({ $and: [baseQuery, segmentQuery] });
  }

  if (audience?.all) {
    return EmailSubscriber.find(baseQuery);
  }

  const matchCriteria = [];
  if (audience?.lists?.length > 0) {
    matchCriteria.push({ lists: { $in: audience.lists } });
  }
  if (audience?.tags?.length > 0) {
    matchCriteria.push({ tags: { $in: audience.tags } });
  }

  if (matchCriteria.length === 0) {
    return null; // Explicitly empty audience
  }

  return EmailSubscriber.find({ ...baseQuery, $or: matchCriteria });
}

/**
 * Deterministic A/B variant assignment: hashing the email means a recipient
 * keeps the same variant across resumed batches and campaign re-sweeps.
 */
export function abVariantForEmail(email: string, splitPercentage: number): "A" | "B" {
  let hash = 5381;
  const input = email.toLowerCase();
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  const bucket = Math.abs(hash) % 100;
  return bucket < splitPercentage ? "A" : "B";
}

export function wrapTextTemplate(html: string, templateType: string): string {
  if (templateType !== "text") return html;
  return `
    <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
      ${html}
    </div>
  `;
}

// ==========================================================================
// Campaigns
// ==========================================================================

/**
 * Handles batch dispatch of scheduled campaigns.
 */
async function processCampaigns(provider: any, trackingUrl: string) {
  // Find scheduled campaigns or those in sending state
  const campaigns = await EmailCampaign.find({
    status: { $in: ["scheduled", "sending"] },
    $or: [{ scheduled_at: { $lte: new Date() } }, { status: "sending" }],
  });

  const summary = [];

  for (const campaign of campaigns) {
    if (campaign.status === "scheduled") {
      campaign.status = "sending";
      await campaign.save();
    }

    let emailResult = null;
    let whatsappResult = null;

    // Check Email leg
    if (["pending", "sending"].includes(campaign.dispatch_status)) {
      emailResult = await sendEmailLegForCampaign(campaign, provider, trackingUrl);
      if (emailResult) {
        campaign.dispatch_status = emailResult.status;
      }
    }

    // Check WhatsApp leg
    if (["pending", "sending"].includes(campaign.whatsapp_dispatch_status)) {
      whatsappResult = await sendWhatsappLegForCampaign(campaign);
      if (whatsappResult) {
        campaign.whatsapp_dispatch_status = whatsappResult.status;
      }
    }

    // Check if both legs are completed
    const emailDone = ["sent", "skipped"].includes(campaign.dispatch_status);
    const whatsappDone = ["sent", "skipped"].includes(campaign.whatsapp_dispatch_status);

    if (emailDone && whatsappDone) {
      campaign.status = "sent";
      campaign.sent_at = new Date();
      await campaign.save();
    }

    if (emailResult || whatsappResult) {
      summary.push({
        campaignId: campaign._id,
        status: campaign.status,
        email: emailResult,
        whatsapp: whatsappResult,
      });
    }
  }

  return summary;
}

async function sendEmailLegForCampaign(campaign: any, provider: any, trackingUrl: string) {
  let claimed = campaign;
  if (campaign.dispatch_status === "pending") {
    // Atomically claim this leg so a concurrent sweep (worker + /api/jobs/process
    // cron) can't both start dispatching the same first batch.
    const result = await EmailCampaign.findOneAndUpdate(
      { _id: campaign._id, dispatch_status: "pending" },
      { $set: { dispatch_status: "sending" } },
      { new: true }
    );
    if (!result) return null;
    claimed = result;
  }

  const abEnabled = !!claimed.ab_test?.enabled;
  const splitPercentage = claimed.ab_test?.split_percentage || 50;

  const templateA = await EmailTemplate.findById(claimed.template_id);
  if (!templateA) {
    claimed.dispatch_status = "skipped";
    await claimed.save();
    return { status: "skipped", error: "Template not found" };
  }

  // Variant B falls back to variant A's template when only the subject differs.
  let templateB = templateA;
  if (abEnabled && claimed.ab_test?.template_id_b) {
    templateB = (await EmailTemplate.findById(claimed.ab_test.template_id_b)) || templateA;
  }

  const subscribers = await resolveAudienceSubscribers(claimed.audience, "email");
  if (subscribers === null) {
    claimed.dispatch_status = "sent";
    await claimed.save();
    return { status: "sent", message: "Empty audience" };
  }

  const sentEmails = await EmailEvent.find({
    campaign_id: claimed._id,
    channel: "email",
    event_type: "sent",
  }).distinct("recipient_email");

  const sentEmailsSet = new Set(sentEmails.map((e) => e.toLowerCase()));

  const pendingSubscribers = subscribers.filter(
    (sub) => sub.email && !sentEmailsSet.has(sub.email.toLowerCase())
  );

  if (pendingSubscribers.length === 0) {
    claimed.dispatch_status = "sent";
    await claimed.save();
    return { status: "sent" };
  }

  // Daily quota guard: never dispatch beyond the rolling 24h SES allowance.
  // Anything over the line stays pending and resumes on a later sweep.
  const quotaRemaining = await getDailyQuotaRemaining();
  if (quotaRemaining <= 0) {
    console.warn(`Daily email quota exhausted — deferring campaign ${claimed._id} to a later sweep`);
    return { status: "sending" as const, deferred: true, reason: "daily_quota_exhausted" };
  }

  const batch = pendingSubscribers.slice(0, Math.min(BATCH_LIMIT, quotaRemaining));

  const source: TrackingSource = { type: "campaign", id: claimed._id.toString() };

  let sentInBatch = 0;
  let failedInBatch = 0;

  for (const sub of batch) {
    const variant: "A" | "B" = abEnabled ? abVariantForEmail(sub.email, splitPercentage) : "A";
    const template = variant === "B" ? templateB : templateA;
    const subjectSource =
      variant === "B" && claimed.ab_test?.subject_b ? claimed.ab_test.subject_b : claimed.subject || "";

    try {
      const customizedHtml = prepareEmailHtml({
        html: template.html_content || "",
        subscriber: sub,
        source,
        trackingUrl,
        trackingEnabled: claimed.tracking,
      });

      const finalHtml = wrapTextTemplate(customizedHtml, template.type);

      const { messageId } = await sendEmailThrottled(provider, {
        to: sub.email,
        fromName: claimed.sender_name,
        fromEmail: claimed.sender_email,
        subject: replaceMergeTags(subjectSource, sub),
        html: finalHtml,
        replyTo: claimed.reply_to,
        headers: buildListUnsubscribeHeaders(trackingUrl, sub.email, source),
      });

      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "sent",
        timestamp: new Date(),
        details: abEnabled ? { messageId, variant } : { messageId },
      });

      sentInBatch++;
    } catch (err: any) {
      console.error(`Failed to send campaign email to ${sub.email}:`, err);
      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: err.message, transient: isTransientSendError(err), variant },
      });
      failedInBatch++;
    }
  }

  claimed.stats.sent += sentInBatch;
  claimed.stats.failed = (claimed.stats.failed || 0) + failedInBatch;
  claimed.dispatch_status =
    pendingSubscribers.length <= batch.length ? "sent" : "sending";
  await claimed.save();

  return {
    status: claimed.dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - batch.length),
  };
}

async function sendWhatsappLegForCampaign(campaign: any) {
  let claimed = campaign;
  if (campaign.whatsapp_dispatch_status === "pending") {
    const result = await EmailCampaign.findOneAndUpdate(
      { _id: campaign._id, whatsapp_dispatch_status: "pending" },
      { $set: { whatsapp_dispatch_status: "sending" } },
      { new: true }
    );
    if (!result) return null;
    claimed = result;
  }

  if (!claimed.whatsapp_template) {
    claimed.whatsapp_dispatch_status = "skipped";
    await claimed.save();
    return { status: "skipped", error: "No whatsapp_template set" };
  }

  const subscribers = await resolveAudienceSubscribers(claimed.audience, "whatsapp");
  if (subscribers === null) {
    claimed.whatsapp_dispatch_status = "sent";
    await claimed.save();
    return { status: "sent", message: "Empty audience" };
  }

  const sentTo = await EmailEvent.find({
    campaign_id: claimed._id,
    channel: "whatsapp",
    event_type: "sent",
  }).distinct("recipient_email");
  const sentSet = new Set(sentTo.map((e) => e.toLowerCase()));

  const pendingSubscribers = subscribers.filter(
    (sub) => sub.email && !sentSet.has(sub.email.toLowerCase())
  );

  if (pendingSubscribers.length === 0) {
    claimed.whatsapp_dispatch_status = "sent";
    await claimed.save();
    return { status: "sent" };
  }

  const batch = pendingSubscribers.slice(0, BATCH_LIMIT);

  let sentInBatch = 0;
  let failedInBatch = 0;

  for (const sub of batch) {
    if (!sub.whatsapp_number) {
      failedInBatch++;
      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "whatsapp",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: "No WhatsApp number on file" },
      });
      continue;
    }

    try {
      // A campaign whose whatsapp_template isn't one of the hardcoded
      // WHATSAPP_TEMPLATES (e.g. a template just approved in MSG91) has no
      // param builder to derive body params from — whatsapp_variables carries
      // the admin-entered values instead, sent as-is to every recipient
      // (no per-recipient personalization for these, since we don't know
      // which slot, if any, is a name).
      let bodyParams: string[];
      let buttonUrlSuffix: string | undefined;
      if (claimed.whatsapp_variables?.length) {
        bodyParams = claimed.whatsapp_variables;
      } else {
        ({ bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(
          claimed.whatsapp_template as WhatsappTemplateName,
          {
            firstName: sub.first_name || "there",
            webinarTitle: claimed.whatsapp_title || claimed.name,
            startsAt: claimed.scheduled_at || claimed.created_at || new Date(),
            timezone: config.branding.timezone,
          }
        ));
      }

      const result = await sendWhatsappTemplate({
        to: sub.whatsapp_number,
        templateName: claimed.whatsapp_template,
        bodyParams,
        buttonUrlSuffix,
      });

      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "whatsapp",
        event_type: "sent",
        timestamp: new Date(),
        details: { messageId: result.messageId },
      });

      sentInBatch++;
    } catch (err: any) {
      console.error(`Failed to send campaign WhatsApp message to ${sub.whatsapp_number}:`, err);
      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "whatsapp",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: err.message },
      });
      failedInBatch++;
    }
  }

  claimed.stats.whatsapp_sent += sentInBatch;
  claimed.stats.whatsapp_failed += failedInBatch;
  claimed.whatsapp_dispatch_status = pendingSubscribers.length <= BATCH_LIMIT ? "sent" : "sending";
  await claimed.save();

  return {
    status: claimed.whatsapp_dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - BATCH_LIMIT),
  };
}

