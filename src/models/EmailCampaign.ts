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
  audience: {
    lists: string[];
    tags: string[];
    all: boolean;
    segment_id?: mongoose.Types.ObjectId;
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
    audience: {
      lists: [{ type: String }],
      tags: [{ type: String }],
      all: { type: Boolean, default: false },
      segment_id: { type: Schema.Types.ObjectId, ref: "Segment" },
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
