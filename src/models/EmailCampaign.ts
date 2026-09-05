import mongoose, { Schema, Document } from "mongoose";

export interface IEmailCampaign extends Document {
  name: string;
  subject?: string;
  sender_name?: string;
  sender_email?: string;
  reply_to?: string;
  template_id?: mongoose.Types.ObjectId;
  channel: "email" | "whatsapp" | "both";
  whatsapp_template?: string;
  /**
   * Overrides the {{webinarTitle}} slot the hardcoded templates in
   * whatsapp-templates.ts fill with campaign.name by default — lets an admin
   * send different customer-facing copy than the internal campaign name.
   */
  whatsapp_title?: string;
  /**
   * Raw body_N parameter values, in order, for a WhatsApp template that isn't
   * one of the hardcoded WHATSAPP_TEMPLATES (e.g. a template just approved in
   * MSG91 that the code has no per-template param builder for yet). When
   * set, these are sent as-is instead of the automatic firstName/title/date
   * derivation — see sendWhatsappLegForCampaign in queue-processor.ts.
   */
  whatsapp_variables?: string[];
  /**
   * Admin-pasted copy of a custom (non-hardcoded) template's approved MSG91
   * body, {{1}}/{{2}}/... placeholders — powers the wizard's live preview
   * only. Never read by the send path; MSG91 already has the real template.
   */
  whatsapp_preview_body?: string;
  audience: {
    lists: string[];
    tags: string[];
    all: boolean;
    segment_id?: mongoose.Types.ObjectId;
    /**
     * Webinar-based audience — an alternative to lists/tags/segment_id, not
     * combinable with them (see resolveAudienceSubscribers in
     * queue-processor.ts for resolution order). webinar_all takes every
     * webinar's audience; webinar_ids selects specific ones. The registered_
     * from/to date range only narrows anything when exactly one webinar_id
     * is selected — across several it's ambiguous which occurrence a date
     * refers to, so it's ignored.
     */
    webinar_ids?: mongoose.Types.ObjectId[];
    webinar_all?: boolean;
    webinar_registered_from?: Date;
    webinar_registered_to?: Date;
  };
  /**
   * A/B subject/template test. When enabled, each recipient is
   * deterministically assigned variant A or B by hashing their email so
   * re-runs of the batch processor never flip a recipient's variant.
   */
  ab_test?: {
    enabled: boolean;
    /** Percentage of the audience receiving variant A (1–99). Remainder gets B. */
    split_percentage: number;
    subject_b?: string;
    template_id_b?: mongoose.Types.ObjectId;
  };
  status: "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled";
  dispatch_status: "pending" | "sending" | "sent" | "skipped";
  whatsapp_dispatch_status: "pending" | "sending" | "sent" | "skipped";
  schedule_type: "immediate" | "scheduled";
  scheduled_at?: Date;
  sent_at?: Date;
  tracking: {
    opens: boolean;
    clicks: boolean;
  };
  stats: {
    sent: number;
    delivered: number;
    opens: number;
    clicks: number;
    bounces: number;
    complaints: number;
    unsubscribed: number;
    /** Send-time infrastructure failures (provider errors) — distinct from real bounces. */
    failed: number;
    whatsapp_sent: number;
    whatsapp_failed: number;
  };
  created_at: Date;
  updated_at: Date;
}

const EmailCampaignSchema = new Schema<IEmailCampaign>(
  {
    name: { type: String, required: true },
    subject: { type: String },
    sender_name: { type: String },
    sender_email: { type: String },
    reply_to: { type: String },
    template_id: { type: Schema.Types.ObjectId, ref: "EmailTemplate" },
    channel: { type: String, enum: ["email", "whatsapp", "both"], default: "email", index: true },
    whatsapp_template: { type: String },
    whatsapp_title: { type: String },
    whatsapp_variables: [{ type: String }],
    whatsapp_preview_body: { type: String },
    audience: {
      lists: [{ type: String }],
      tags: [{ type: String }],
      all: { type: Boolean, default: false },
      segment_id: { type: Schema.Types.ObjectId, ref: "Segment" },
      webinar_ids: [{ type: Schema.Types.ObjectId, ref: "Webinar" }],
      webinar_all: { type: Boolean, default: false },
      webinar_registered_from: { type: Date },
      webinar_registered_to: { type: Date },
    },
    ab_test: {
      enabled: { type: Boolean, default: false },
      split_percentage: { type: Number, default: 50, min: 1, max: 99 },
      subject_b: { type: String },
      template_id_b: { type: Schema.Types.ObjectId, ref: "EmailTemplate" },
    },
    status: { 
      type: String, 
      enum: ["draft", "scheduled", "sending", "sent", "paused", "cancelled"], 
      default: "draft",
      index: true
    },
    dispatch_status: {
      type: String,
      enum: ["pending", "sending", "sent", "skipped"],
      default: "pending",
      index: true,
    },
    whatsapp_dispatch_status: {
      type: String,
      enum: ["pending", "sending", "sent", "skipped"],
      default: "skipped",
      index: true,
    },
    schedule_type: { type: String, enum: ["immediate", "scheduled"], default: "immediate" },
    scheduled_at: { type: Date, index: true },
    sent_at: { type: Date },
    tracking: {
      opens: { type: Boolean, default: true },
      clicks: { type: Boolean, default: true },
    },
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opens: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      bounces: { type: Number, default: 0 },
      complaints: { type: Number, default: 0 },
      unsubscribed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      whatsapp_sent: { type: Number, default: 0 },
      whatsapp_failed: { type: Number, default: 0 },
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
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

export default mongoose.models.EmailCampaign || mongoose.model<IEmailCampaign>("EmailCampaign", EmailCampaignSchema);
