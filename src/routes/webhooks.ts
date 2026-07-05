import { Router, Request, Response } from "express";
import EmailEvent from "../models/EmailEvent";
import EmailCampaign from "../models/EmailCampaign";
import EmailSubscriber from "../models/EmailSubscriber";

const router = Router();

// POST /api/webhooks/aws-ses - AWS SES SNS Webhook Handler
router.post("/aws-ses", async (req: Request, res: Response) => {
  try {
    let body = req.body;
    
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    // Handle SNS Subscription Confirmation
    if (body.Type === "SubscriptionConfirmation") {
      console.log(`[AWS Webhook] Subscription Confirmation. Please confirm in AWS SNS console or request the URL: ${body.SubscribeURL}`);
      return res.json({ status: "SubscriptionConfirmationLogged" });
    }

    if (body.Type === "Notification") {
      const message = JSON.parse(body.Message);
      const eventType = message.eventType; // "Bounce", "Complaint", "Delivery"
      const mail = message.mail;
      const messageId = mail.messageId;

      console.log(`[AWS Webhook] Event received: ${eventType} for messageId: ${messageId}`);

      // Look up original sent event to resolve campaign_id / subscriber email
      const originalSentEvent = await EmailEvent.findOne({
        "details.messageId": messageId,
        event_type: "sent"
      });

      if (eventType === "Bounce") {
        const bounce = message.bounce;
        const bouncedRecipients = bounce.bouncedRecipients || [];

        for (const recipient of bouncedRecipients) {
          const email = recipient.emailAddress.toLowerCase();
          
          // Mark subscriber status
          await EmailSubscriber.findOneAndUpdate(
            { email },
            { status: "bounced" }
          );

          const campaignId = originalSentEvent?.campaign_id;
          const automationId = originalSentEvent?.automation_id;

          // Check if bounce event already recorded
          const query: any = {
            recipient_email: email,
            event_type: "bounce"
          };
          if (campaignId) query.campaign_id = campaignId;
          if (automationId) query.automation_id = automationId;

          const alreadyBounced = await EmailEvent.exists(query);

          await EmailEvent.create({
            campaign_id: campaignId,
            automation_id: automationId,
            recipient_email: email,
            event_type: "bounce",
            timestamp: new Date(),
            details: { 
              bounceType: bounce.bounceType, 
              bounceSubType: bounce.bounceSubType,
              messageId
            }
          });

          if (!alreadyBounced) {
            if (campaignId) {
              await EmailCampaign.findByIdAndUpdate(campaignId, {
                $inc: { "stats.bounces": 1 },
              });
            }
          }
        }
      }

      if (eventType === "Complaint") {
        const complaint = message.complaint;
        const complainedRecipients = complaint.complainedRecipients || [];

        for (const recipient of complainedRecipients) {
          const email = recipient.emailAddress.toLowerCase();

          // Mark subscriber status
          await EmailSubscriber.findOneAndUpdate(
            { email },
            { status: "complained" }
          );

          const campaignId = originalSentEvent?.campaign_id;
          const automationId = originalSentEvent?.automation_id;

          const query: any = {
            recipient_email: email,
            event_type: "complaint"
          };
          if (campaignId) query.campaign_id = campaignId;
          if (automationId) query.automation_id = automationId;

          const alreadyComplained = await EmailEvent.exists(query);

          await EmailEvent.create({
            campaign_id: campaignId,
            automation_id: automationId,
            recipient_email: email,
            event_type: "complaint",
            timestamp: new Date(),
            details: { 
              complaintFeedbackType: complaint.complaintFeedbackType,
              messageId
            }
          });

          if (!alreadyComplained) {
            if (campaignId) {
              await EmailCampaign.findByIdAndUpdate(campaignId, {
                $inc: { "stats.complaints": 1 },
              });
            }
          }
        }
      }
    }

    return res.json({ status: "success" });
  } catch (error: any) {
    console.error("AWS Webhook processing error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
