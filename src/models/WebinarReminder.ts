import mongoose, { Schema, Document } from "mongoose";

export type WebinarReminderOffsetType =
  | "days_before"
  | "hours_before"
  | "minutes_before"
  | "at_start"
  | "custom";

export type WebinarReminderChannel = "email" | "whatsapp" | "both";
export type WebinarReminderDispatchStatus = "pending" | "sending" | "sent" | "skipped";

export interface IWebinarReminder extends Document {
  webinar_id: mongoose.Types.ObjectId;
  name: string;
  offset_type: WebinarReminderOffsetType;
  offset_value?: number;
  custom_at?: Date;
  channel: WebinarReminderChannel;
  // Email leg — only required when channel is "email" or "both".
  template_id?: mongoose.Types.ObjectId;
  subject?: string;
  sender_name?: string;
  sender_email?: string;
  // WhatsApp leg — only required when channel is "whatsapp" or "both".
  whatsapp_template?: string;
  status: "active" | "paused" | "cancelled";
  computed_send_at: Date;
  // Independent per-channel dispatch state, since a "both" reminder can have
  // one leg finish sending while the other is still batching/resuming.
  dispatch_status: WebinarReminderDispatchStatus;
  whatsapp_dispatch_status: WebinarReminderDispatchStatus;
  stats: {
    sent: number;
    delivered: number;
    opens: number;
    clicks: number;
    bounces: number;
    whatsapp_sent: number;
    whatsapp_failed: number;
  };
  created_at: Date;
  updated_at: Date;
}

const WebinarReminderSchema = new Schema<IWebinarReminder>(
  {
    webinar_id: { type: Schema.Types.ObjectId, ref: "Webinar", required: true, index: true },
    name: { type: String, required: true },
    offset_type: {
      type: String,
      enum: ["days_before", "hours_before", "minutes_before", "at_start", "custom"],
      required: true,
    },
    offset_value: { type: Number },
    custom_at: { type: Date },
    channel: { type: String, enum: ["email", "whatsapp", "both"], default: "email", index: true },
    template_id: { type: Schema.Types.ObjectId, ref: "EmailTemplate" },
    subject: { type: String },
    sender_name: { type: String },
    sender_email: { type: String },
    whatsapp_template: { type: String },
    status: { type: String, enum: ["active", "paused", "cancelled"], default: "active", index: true },
    computed_send_at: { type: Date, required: true, index: true },
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
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opens: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      bounces: { type: Number, default: 0 },
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

export default mongoose.models.WebinarReminder ||
  mongoose.model<IWebinarReminder>("WebinarReminder", WebinarReminderSchema);
