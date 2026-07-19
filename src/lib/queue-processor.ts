import EmailSubscriber from "../models/EmailSubscriber";
import EmailCampaign from "../models/EmailCampaign";
import EmailTemplate from "../models/EmailTemplate";
import EmailEvent from "../models/EmailEvent";
import Segment from "../models/Segment";
import WebinarReminder from "../models/WebinarReminder";
import { getEmailProvider } from "../providers/provider-factory";
import {
  prepareEmailHtml,
  replaceMergeTags,
  buildListUnsubscribeHeaders,
  TrackingSource,
} from "./tracking-parser";
import { buildSubscriberQueryForSegment } from "./segment-query";
import { sendEmailThrottled, getDailyQuotaRemaining, isTransientSendError } from "./send-throttle";
import { syncWebinarsFromWebsite, syncRegistrantsForWebinar, webinarTag } from "./webinar-sync";
import { config } from "../config";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams, describeOffset, type WhatsappTemplateName } from "./whatsapp-templates";

const BATCH_LIMIT = 50;

/**
 * Executes a full queue processing sweep.
 */
export async function runQueueSweep(trackingUrl: string) {
  const provider = getEmailProvider();

  const campaignResults = await processCampaigns(provider, trackingUrl);
  const webinarReminderResults = await processWebinarReminders(provider, trackingUrl);

  return {
    campaigns: campaignResults,
    webinarReminders: webinarReminderResults,
  };
}

// ==========================================================================
// Audience + A/B helpers
// ==========================================================================

/**
 * Resolves a campaign's audience definition to the list of currently
 * subscribed recipients. Supports "all", lists/tags matching, and saved
 * segments.
 */
async function resolveAudienceSubscribers(audience: any): Promise<any[] | null> {
  const baseQuery: any = { status: "subscribed" };

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

function wrapTextTemplate(html: string, templateType: string): string {
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

  const subscribers = await resolveAudienceSubscribers(claimed.audience);
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

  const subscribers = await resolveAudienceSubscribers(claimed.audience);
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
      const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(
        claimed.whatsapp_template as WhatsappTemplateName,
        {
          firstName: sub.first_name || "there",
          webinarTitle: claimed.name,
          startsAt: claimed.scheduled_at || claimed.created_at || new Date(),
          timezone: config.branding.timezone,
        }
      );

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

// ==========================================================================
// Webinar reminders
// ==========================================================================

/**
 * Handles dispatch of due webinar reminder emails.
 */
async function processWebinarReminders(provider: any, trackingUrl: string) {
  await syncWebinarsFromWebsite();

  const dueReminders = await WebinarReminder.find({
    status: "active",
    computed_send_at: { $lte: new Date() },
    $or: [
      { dispatch_status: { $in: ["pending", "sending"] } }, // "sending" = resuming a partially-sent batch
      { whatsapp_dispatch_status: { $in: ["pending", "sending"] } },
    ],
  }).populate("webinar_id");

  const summary = [];

  for (const reminder of dueReminders) {
    const webinar: any = reminder.webinar_id;
    if (!webinar) continue;

    if (webinar.status === "cancelled") {
      if (["pending", "sending"].includes(reminder.dispatch_status)) reminder.dispatch_status = "skipped";
      if (["pending", "sending"].includes(reminder.whatsapp_dispatch_status))
        reminder.whatsapp_dispatch_status = "skipped";
      await reminder.save();
      summary.push({ reminderId: reminder._id, status: "skipped", reason: "Webinar cancelled" });
      continue;
    }

    if (webinar.status !== "upcoming") {
      continue;
    }

    await syncRegistrantsForWebinar(webinar);
    const tag = webinarTag(webinar);

    if (["pending", "sending"].includes(reminder.dispatch_status)) {
      const result = await sendEmailLegForReminder(reminder, webinar, tag, provider, trackingUrl);
      if (result) summary.push(result);
    }

    if (["pending", "sending"].includes(reminder.whatsapp_dispatch_status)) {
      const result = await sendWhatsappLegForReminder(reminder, webinar, tag);
      if (result) summary.push(result);
    }
  }

  return summary;
}

async function sendEmailLegForReminder(reminder: any, webinar: any, tag: string, provider: any, trackingUrl: string) {
  let claimed = reminder;
  if (reminder.dispatch_status === "pending") {
    // Atomically claim this leg so a concurrent sweep (worker + /api/jobs/process
    // cron) can't both start dispatching the same first batch.
    const result = await WebinarReminder.findOneAndUpdate(
      { _id: reminder._id, dispatch_status: "pending" },
      { $set: { dispatch_status: "sending" } },
      { new: true }
    );
    if (!result) return null;
    claimed = result;
  }

  const template = await EmailTemplate.findById(claimed.template_id);
  if (!template) {
    claimed.dispatch_status = "skipped";
    await claimed.save();
    return { reminderId: reminder._id, channel: "email", status: "failed", error: "Template not found" };
  }

  const subscribers = await EmailSubscriber.find({ status: "subscribed", tags: tag });

  const sentEmails = await EmailEvent.find({
    reminder_id: claimed._id,
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
    return { reminderId: claimed._id, channel: "email", status: "sent", message: "Empty audience" };
  }

  // Daily quota guard — same rolling window shared with campaigns.
  const quotaRemaining = await getDailyQuotaRemaining();
  if (quotaRemaining <= 0) {
    console.warn(`Daily email quota exhausted — deferring reminder ${claimed._id} to a later sweep`);
    return { reminderId: claimed._id, channel: "email", status: "sending", deferred: true };
  }

  const batch = pendingSubscribers.slice(0, Math.min(BATCH_LIMIT, quotaRemaining));

  const source: TrackingSource = { type: "reminder", id: claimed._id.toString() };

  let sentInBatch = 0;
  let failedInBatch = 0;

  // The reminder's webinar is authoritative for {{join_link}}/{{webinar}} —
  // subscriber metadata can lag behind a registrant sync, and the WhatsApp
  // leg already derives its button suffix from source_window_id.
  const reminderTagOverrides: Record<string, string> = {
    "{{join_link}}": `${config.mainWebsite.url}/webinar/join/${webinar.source_window_id}`,
    "{{webinar}}": webinar.title,
  };

  for (const sub of batch) {
    try {
      const customizedHtml = prepareEmailHtml({
        html: template.html_content || "",
        subscriber: sub,
        source,
        trackingUrl,
        trackingEnabled: { opens: true, clicks: true },
        tagOverrides: reminderTagOverrides,
      });

      const finalHtml = wrapTextTemplate(customizedHtml, template.type);

      const { messageId } = await sendEmailThrottled(provider, {
        to: sub.email,
        fromName: claimed.sender_name,
        fromEmail: claimed.sender_email,
        subject: replaceMergeTags(claimed.subject, sub, reminderTagOverrides),
        html: finalHtml,
        headers: buildListUnsubscribeHeaders(trackingUrl, sub.email, source),
      });

      await EmailEvent.create({
        reminder_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "sent",
        timestamp: new Date(),
        details: { messageId },
      });

      sentInBatch++;
    } catch (err: any) {
      console.error(`Failed to send webinar reminder email to ${sub.email}:`, err);
      await EmailEvent.create({
        reminder_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: err.message, transient: isTransientSendError(err) },
      });
      failedInBatch++;
    }
  }

  claimed.stats.sent += sentInBatch;
  claimed.stats.failed = (claimed.stats.failed || 0) + failedInBatch;
  claimed.dispatch_status = pendingSubscribers.length <= batch.length ? "sent" : "sending";
  await claimed.save();

  return {
    reminderId: claimed._id,
    channel: "email",
    status: claimed.dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - batch.length),
  };
}

async function sendWhatsappLegForReminder(reminder: any, webinar: any, tag: string) {
  let claimed = reminder;
  if (reminder.whatsapp_dispatch_status === "pending") {
    const result = await WebinarReminder.findOneAndUpdate(
      { _id: reminder._id, whatsapp_dispatch_status: "pending" },
      { $set: { whatsapp_dispatch_status: "sending" } },
      { new: true }
    );
    if (!result) return null;
    claimed = result;
  }

  if (!claimed.whatsapp_template) {
    claimed.whatsapp_dispatch_status = "skipped";
    await claimed.save();
    return { reminderId: reminder._id, channel: "whatsapp", status: "failed", error: "No whatsapp_template set" };
  }

  const subscribers = await EmailSubscriber.find({ status: "subscribed", tags: tag });

  const sentTo = await EmailEvent.find({
    reminder_id: claimed._id,
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
    return { reminderId: claimed._id, channel: "whatsapp", status: "sent", message: "Empty audience" };
  }

  const batch = pendingSubscribers.slice(0, BATCH_LIMIT);
  const relativePhrase = describeOffset(claimed.offset_type, claimed.offset_value);

  let sentInBatch = 0;
  let failedInBatch = 0;

  for (const sub of batch) {
    if (!sub.whatsapp_number) {
      failedInBatch++;
      await EmailEvent.create({
        reminder_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "whatsapp",
        event_type: "failed",
        timestamp: new Date(),
        details: { error: "No WhatsApp number on file" },
      });
      continue;
    }

    try {
      const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(
        claimed.whatsapp_template as WhatsappTemplateName,
        {
          firstName: sub.first_name || "there",
          webinarTitle: webinar.title,
          startsAt: webinar.starts_at,
          timezone: webinar.timezone,
          relativeTimePhrase: relativePhrase,
          joinSuffix: String(webinar.source_window_id),
        }
      );

      const result = await sendWhatsappTemplate({
        to: sub.whatsapp_number,
        templateName: claimed.whatsapp_template,
        bodyParams,
        buttonUrlSuffix,
      });

      await EmailEvent.create({
        reminder_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "whatsapp",
        event_type: "sent",
        timestamp: new Date(),
        details: { messageId: result.messageId },
      });

      sentInBatch++;
    } catch (err: any) {
      console.error(`Failed to send webinar reminder WhatsApp message to ${sub.whatsapp_number}:`, err);
      await EmailEvent.create({
        reminder_id: claimed._id,
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
    reminderId: claimed._id,
    channel: "whatsapp",
    status: claimed.whatsapp_dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - BATCH_LIMIT),
  };
}
