import mongoose, { Schema, Document } from "mongoose";

export interface IEmailEvent extends Document {
  campaign_id?: mongoose.Types.ObjectId;
  reminder_id?: mongoose.Types.ObjectId;
  webinar_id?: mongoose.Types.ObjectId;
  /**
   * Dedup key for webinar lifecycle WhatsApp notices (cancellation/reschedule),
   * e.g. "webinar_cancelled" or "webinar_rescheduled:<new ISO start>". Scoped
   * per webinar occurrence via webinar_id — see the unique index below.
   */
  lifecycle_event?: string;
  recipient_email: string;
  /** Which channel this event belongs to — defaults to "email" for all pre-existing rows. */
  channel: "email" | "whatsapp";
  /**
   * "bounce"/"complaint" are real recipient-side delivery outcomes (from the
   * SES feedback webhook). "failed" is an infrastructure/send-time failure
   * (provider error, missing WhatsApp number, throttle exhaustion) — kept
   * separate so deliverability stats aren't polluted by transient errors.
   */
  event_type: "sent" | "delivered" | "open" | "click" | "bounce" | "complaint" | "unsubscribe" | "failed";
  timestamp: Date;
  ip_address?: string;
  user_agent?: string;
  device_type?: string;
  browser?: string;
  link_url?: string;
  details?: Record<string, any>;
}

const EmailEventSchema = new Schema<IEmailEvent>(
  {
    campaign_id: { type: Schema.Types.ObjectId, ref: "EmailCampaign", index: true },
    reminder_id: { type: Schema.Types.ObjectId, ref: "WebinarReminder", index: true },
    webinar_id: { type: Schema.Types.ObjectId, ref: "Webinar", index: true },
    lifecycle_event: { type: String },
    recipient_email: { type: String, required: true, index: true },
    channel: { type: String, enum: ["email", "whatsapp"], default: "email", index: true },
    event_type: {
      type: String, 
      enum: ["sent", "delivered", "open", "click", "bounce", "complaint", "unsubscribe", "failed"],
      required: true, 
      index: true 
    },
    timestamp: { type: Date, default: Date.now, index: true },
    ip_address: { type: String },
    user_agent: { type: String },
    device_type: { type: String },
    browser: { type: String },
    link_url: { type: String },
    details: { type: Schema.Types.Mixed },
  },
  {
    toJSON: {
      transform: (_: any, ret: any) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// High-utility composite indexes for analytics reporting
EmailEventSchema.index({ campaign_id: 1, event_type: 1 });
EmailEventSchema.index({ reminder_id: 1, event_type: 1 });
EmailEventSchema.index({ recipient_email: 1, timestamp: -1 });
EmailEventSchema.index({ timestamp: -1 });

// Hard DB-level backstop against duplicate sends: at most one "sent" event
// per (reminder, recipient, channel) or (campaign, recipient, channel). The
// application-level "already sent?" checks upstream (fan-out.ts,
// whatsapp-send.worker.ts, email-send.worker.ts) are check-then-act and can
// race under concurrent workers/retries/reconcile sweeps — this index turns
// a lost race into a harmless duplicate-key error instead of a second real
// send already having gone out.
EmailEventSchema.index(
  { reminder_id: 1, recipient_email: 1, channel: 1 },
  { unique: true, partialFilterExpression: { event_type: "sent", reminder_id: { $exists: true } } }
);
EmailEventSchema.index(
  { campaign_id: 1, recipient_email: 1, channel: 1 },
  { unique: true, partialFilterExpression: { event_type: "sent", campaign_id: { $exists: true } } }
);
// Same backstop for webinar lifecycle notices (cancellation/reschedule sent
// via sendLifecycleWhatsapp): at most one "sent" per (webinar occurrence,
// lifecycle key, recipient). These sends are claim-first — the row is
// inserted BEFORE hitting MSG91, so two processes syncing the same webinar
// concurrently (the API server's Sync Now and the queue worker's pre-dispatch
// force sync) can't both blast the same notice: the loser gets a duplicate-key
// error and skips.
EmailEventSchema.index(
  { webinar_id: 1, lifecycle_event: 1, recipient_email: 1 },
  { unique: true, partialFilterExpression: { event_type: "sent", lifecycle_event: { $exists: true } } }
);

export default mongoose.models.EmailEvent || mongoose.model<IEmailEvent>("EmailEvent", EmailEventSchema);
