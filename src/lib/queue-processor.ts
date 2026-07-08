import EmailSubscriber from "../models/EmailSubscriber";
import EmailCampaign from "../models/EmailCampaign";
import EmailTemplate from "../models/EmailTemplate";
import EmailAutomation from "../models/EmailAutomation";
import EmailEvent from "../models/EmailEvent";
import Webinar from "../models/Webinar";
import WebinarReminder from "../models/WebinarReminder";
import { getEmailProvider } from "../providers/provider-factory";
import { prepareEmailHtml, replaceMergeTags } from "./tracking-parser";
import { syncWebinarsFromWebsite, syncRegistrantsForWebinar, webinarTag } from "./webinar-sync";
import { sendWhatsappTemplate } from "../providers/msg91-whatsapp.provider";
import { buildWhatsappTemplateParams, describeOffset, type WhatsappTemplateName } from "./whatsapp-templates";

/**
 * Executes a full queue processing sweep.
 */
export async function runQueueSweep(trackingUrl: string) {
  const provider = getEmailProvider();

  const campaignResults = await processCampaigns(provider, trackingUrl);
  const automationResults = await processAutomations(provider, trackingUrl);
  const webinarReminderResults = await processWebinarReminders(provider, trackingUrl);

  return {
    campaigns: campaignResults,
    automations: automationResults,
    webinarReminders: webinarReminderResults
  };
}

/**
 * Handles batch dispatch of scheduled campaigns.
 */
async function processCampaigns(provider: any, trackingUrl: string) {
  // Find scheduled campaigns or those in sending state
  const campaigns = await EmailCampaign.find({
    status: { $in: ["scheduled", "sending"] },
    $or: [
      { scheduled_at: { $lte: new Date() } },
      { status: "sending" }
    ]
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
    const result = await EmailCampaign.findOneAndUpdate(
      { _id: campaign._id, dispatch_status: "pending" },
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
    return { status: "skipped", error: "Template not found" };
  }

  // Resolve the target audience
  const audienceQuery: any = { status: "subscribed" };

  if (!claimed.audience.all) {
    const matchCriteria = [];
    if (claimed.audience.lists?.length > 0) {
      matchCriteria.push({ lists: { $in: claimed.audience.lists } });
    }
    if (claimed.audience.tags?.length > 0) {
      matchCriteria.push({ tags: { $in: claimed.audience.tags } });
    }
    
    if (matchCriteria.length > 0) {
      audienceQuery["$or"] = matchCriteria;
    } else {
      claimed.dispatch_status = "sent";
      await claimed.save();
      return { status: "sent", message: "Empty audience" };
    }
  }

  const subscribers = await EmailSubscriber.find(audienceQuery);
  
  const sentEmails = await EmailEvent.find({
    campaign_id: claimed._id,
    channel: "email",
    event_type: "sent"
  }).distinct("recipient_email");

  const sentEmailsSet = new Set(sentEmails.map(e => e.toLowerCase()));

  const pendingSubscribers = subscribers.filter(
    (sub) => !sentEmailsSet.has(sub.email.toLowerCase())
  );

  if (pendingSubscribers.length === 0) {
    claimed.dispatch_status = "sent";
    await claimed.save();
    return { status: "sent" };
  }

  const BATCH_LIMIT = 50;
  const batch = pendingSubscribers.slice(0, BATCH_LIMIT);

  let sentInBatch = 0;
  let failedInBatch = 0;

  for (const sub of batch) {
    try {
      const customizedHtml = prepareEmailHtml({
        html: template.html_content || "",
        subscriber: sub,
        campaignId: claimed._id.toString(),
        trackingUrl,
        trackingEnabled: claimed.tracking,
      });

      let finalHtml = customizedHtml;
      if (template.type === "text") {
        finalHtml = `
          <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
            ${customizedHtml}
          </div>
        `;
      }

      const { messageId } = await provider.sendEmail({
        to: sub.email,
        fromName: claimed.sender_name,
        fromEmail: claimed.sender_email,
        subject: replaceMergeTags(claimed.subject || "", sub),
        html: finalHtml,
        replyTo: claimed.reply_to,
      });

      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "sent",
        timestamp: new Date(),
        details: { messageId }
      });

      sentInBatch++;
    } catch (err: any) {
      console.error(`Failed to send campaign email to ${sub.email}:`, err);
      await EmailEvent.create({
        campaign_id: claimed._id,
        recipient_email: sub.email.toLowerCase(),
        channel: "email",
        event_type: "bounce",
        timestamp: new Date(),
        details: { error: err.message }
      });
      failedInBatch++;
    }
  }

  claimed.stats.sent += sentInBatch;
  claimed.stats.bounces += failedInBatch;
  claimed.dispatch_status = pendingSubscribers.length <= BATCH_LIMIT ? "sent" : "sending";
  await claimed.save();

  return {
    status: claimed.dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - BATCH_LIMIT),
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

  // Resolve the target audience
  const audienceQuery: any = { status: "subscribed" };

  if (!claimed.audience.all) {
    const matchCriteria = [];
    if (claimed.audience.lists?.length > 0) {
      matchCriteria.push({ lists: { $in: claimed.audience.lists } });
    }
    if (claimed.audience.tags?.length > 0) {
      matchCriteria.push({ tags: { $in: claimed.audience.tags } });
    }
    
    if (matchCriteria.length > 0) {
      claimed.whatsapp_dispatch_status = "sent";
      await claimed.save();
      return { status: "sent", message: "Empty audience" };
    }
  }

  const subscribers = await EmailSubscriber.find(audienceQuery);

  const sentTo = await EmailEvent.find({
    campaign_id: claimed._id,
    channel: "whatsapp",
    event_type: "sent",
  }).distinct("recipient_email");
  const sentSet = new Set(sentTo.map((e) => e.toLowerCase()));

  const pendingSubscribers = subscribers.filter((sub) => !sentSet.has(sub.email.toLowerCase()));

  if (pendingSubscribers.length === 0) {
    claimed.whatsapp_dispatch_status = "sent";
    await claimed.save();
    return { status: "sent" };
  }

  const BATCH_LIMIT = 50;
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
        event_type: "bounce",
        timestamp: new Date(),
        details: { error: "No WhatsApp number on file" },
      });
      continue;
    }

    try {
      const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(claimed.whatsapp_template as WhatsappTemplateName, {
        firstName: sub.first_name || "there",
        webinarTitle: claimed.name,
        startsAt: claimed.scheduled_at || claimed.created_at || new Date(),
        timezone: "Asia/Kolkata",
      });

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
        event_type: "bounce",
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

/**
 * Handles execution of active drip automation steps.
 */
async function processAutomations(provider: any, trackingUrl: string) {
  const automations = await EmailAutomation.find({ status: "active" });
  const summary = [];

  for (const automation of automations) {
    const activeEnrollments = automation.enrollments.filter(
      (enroll: any) => enroll.status === "active" && enroll.next_run_at <= new Date()
    );

    if (activeEnrollments.length === 0) continue;

    let processedCount = 0;

    for (const enroll of activeEnrollments) {
      try {
        const subscriber = await EmailSubscriber.findById(enroll.subscriber_id);
        if (!subscriber || subscriber.status !== "subscribed") {
          enroll.status = "completed";
          continue;
        }

        const currentStep = automation.steps.find((s: any) => s.id === enroll.current_step_id);
        if (!currentStep) {
          enroll.status = "completed";
          continue;
        }

        let nextStepId = currentStep.next_step_id;
        let nextRunAt = new Date();

        if (currentStep.type === "email") {
          const emailConfig = currentStep.email_config;
          if (emailConfig) {
            const template = await EmailTemplate.findById(emailConfig.template_id);
            if (template) {
              const customizedHtml = prepareEmailHtml({
                html: template.html_content || "",
                subscriber,
                campaignId: automation._id.toString(),
                trackingUrl,
                trackingEnabled: { opens: true, clicks: true },
              });

              let finalHtml = customizedHtml;
              if (template.type === "text") {
                finalHtml = `
                  <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
                    ${customizedHtml}
                  </div>
                `;
              }

              const { messageId } = await provider.sendEmail({
                to: subscriber.email,
                fromName: emailConfig.sender_name,
                fromEmail: emailConfig.sender_email,
                subject: emailConfig.subject,
                html: finalHtml,
              });

              await EmailEvent.create({
                automation_id: automation._id,
                recipient_email: subscriber.email.toLowerCase(),
                event_type: "sent",
                timestamp: new Date(),
                details: { messageId, step_id: currentStep.id }
              });

              enroll.history.push({
                step_id: currentStep.id,
                executed_at: new Date(),
                status: "success",
              });
            } else {
              throw new Error(`Email template not found: ${emailConfig.template_id}`);
            }
          }
        } 
        else if (currentStep.type === "delay") {
          const delayConfig = currentStep.delay_config;
          if (delayConfig) {
            const now = new Date();
            let addedMs = 0;
            if (delayConfig.unit === "minutes") addedMs = delayConfig.duration * 60 * 1000;
            else if (delayConfig.unit === "hours") addedMs = delayConfig.duration * 60 * 60 * 1000;
            else if (delayConfig.unit === "days") addedMs = delayConfig.duration * 24 * 60 * 60 * 1000;

            nextRunAt = new Date(now.getTime() + addedMs);
            enroll.history.push({
              step_id: currentStep.id,
              executed_at: new Date(),
              status: "success",
              details: `Delayed for ${delayConfig.duration} ${delayConfig.unit}`,
            });
          }
        } 
        else if (currentStep.type === "condition") {
          const condition = currentStep.condition_config;
          let conditionMet = false;

          if (condition) {
            if (condition.field === "tag") {
              conditionMet = subscriber.tags.includes(condition.value);
            } 
            else if (condition.field === "open") {
              conditionMet = await EmailEvent.exists({
                automation_id: automation._id,
                recipient_email: subscriber.email.toLowerCase(),
                event_type: "open",
              }) !== null;
            } 
            else if (condition.field === "click") {
              conditionMet = await EmailEvent.exists({
                automation_id: automation._id,
                recipient_email: subscriber.email.toLowerCase(),
                event_type: "click",
              }) !== null;
            }

            nextStepId = conditionMet ? condition.yes_step_id : condition.no_step_id;
            
            enroll.history.push({
              step_id: currentStep.id,
              executed_at: new Date(),
              status: "success",
              details: `Condition checked: met=${conditionMet}`,
            });
          }
        }

        if (nextStepId) {
          enroll.current_step_id = nextStepId;
          enroll.next_run_at = nextRunAt;
        } else {
          enroll.status = "completed";
          automation.stats.completed += 1;
        }

        processedCount++;
      } catch (err: any) {
        console.error(`Error processing automation step for subscriber ${enroll.subscriber_id}:`, err);
        enroll.history.push({
          step_id: enroll.current_step_id,
          executed_at: new Date(),
          status: "failed",
          details: err.message,
        });
        
        enroll.next_run_at = new Date(Date.now() + 5 * 60 * 1000);
      }
    }

    await automation.save();
    summary.push({
      automationId: automation._id,
      name: automation.name,
      processedEnrollments: processedCount,
    });
  }

  return summary;
}

/**
 * Handles dispatch of due webinar reminder emails.
 */
const BATCH_LIMIT = 50;

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
      if (["pending", "sending"].includes(reminder.whatsapp_dispatch_status)) reminder.whatsapp_dispatch_status = "skipped";
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

  const pendingSubscribers = subscribers.filter((sub) => !sentEmailsSet.has(sub.email.toLowerCase()));

  if (pendingSubscribers.length === 0) {
    claimed.dispatch_status = "sent";
    await claimed.save();
    return { reminderId: claimed._id, channel: "email", status: "sent", message: "Empty audience" };
  }

  const batch = pendingSubscribers.slice(0, BATCH_LIMIT);

  let sentInBatch = 0;
  let failedInBatch = 0;

  for (const sub of batch) {
    try {
      const customizedHtml = prepareEmailHtml({
        html: template.html_content || "",
        subscriber: sub,
        campaignId: claimed._id.toString(),
        trackingUrl,
        trackingEnabled: { opens: true, clicks: true },
      });

      let finalHtml = customizedHtml;
      if (template.type === "text") {
        finalHtml = `
          <div style="font-family: sans-serif; font-size: 15px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">
            ${customizedHtml}
          </div>
        `;
      }

      const { messageId } = await provider.sendEmail({
        to: sub.email,
        fromName: claimed.sender_name,
        fromEmail: claimed.sender_email,
        subject: replaceMergeTags(claimed.subject, sub),
        html: finalHtml,
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
        event_type: "bounce",
        timestamp: new Date(),
        details: { error: err.message },
      });
      failedInBatch++;
    }
  }

  claimed.stats.sent += sentInBatch;
  claimed.stats.bounces += failedInBatch;
  claimed.dispatch_status = pendingSubscribers.length <= BATCH_LIMIT ? "sent" : "sending";
  await claimed.save();

  return {
    reminderId: claimed._id,
    channel: "email",
    status: claimed.dispatch_status,
    sentCount: sentInBatch,
    failedCount: failedInBatch,
    remaining: Math.max(0, pendingSubscribers.length - BATCH_LIMIT),
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

  const pendingSubscribers = subscribers.filter((sub) => !sentSet.has(sub.email.toLowerCase()));

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
        event_type: "bounce",
        timestamp: new Date(),
        details: { error: "No WhatsApp number on file" },
      });
      continue;
    }

    try {
      const { bodyParams, buttonUrlSuffix } = buildWhatsappTemplateParams(claimed.whatsapp_template as WhatsappTemplateName, {
        firstName: sub.first_name || "there",
        webinarTitle: webinar.title,
        startsAt: webinar.starts_at,
        timezone: webinar.timezone,
        relativeTimePhrase: relativePhrase,
        joinSuffix: webinar._id.toString(),
      });

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
        event_type: "bounce",
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
