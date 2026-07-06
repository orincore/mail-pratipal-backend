import mongoose, { Schema, Document } from "mongoose";

export type WebinarReminderOffsetType =
  | "days_before"
  | "hours_before"
  | "minutes_before"
  | "at_start"
  | "custom";

export interface IWebinarReminder extends Document {
  webinar_id: mongoose.Types.ObjectId;
  name: string;
  offset_type: WebinarReminderOffsetType;
  offset_value?: number;
  custom_at?: Date;
  template_id: mongoose.Types.ObjectId;
  subject: string;
  sender_name: string;
  sender_email: string;
  status: "active" | "paused" | "cancelled";
  computed_send_at: Date;
  dispatch_status: "pending" | "sending" | "sent" | "skipped";
  stats: {
    sent: number;
    delivered: number;
    opens: number;
    clicks: number;
    bounces: number;
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
    template_id: { type: Schema.Types.ObjectId, ref: "EmailTemplate", required: true },
    subject: { type: String, required: true },
    sender_name: { type: String, required: true },
    sender_email: { type: String, required: true },
    status: { type: String, enum: ["active", "paused", "cancelled"], default: "active", index: true },
    computed_send_at: { type: Date, required: true, index: true },
    dispatch_status: {
      type: String,
      enum: ["pending", "sending", "sent", "skipped"],
      default: "pending",
      index: true,
    },
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      opens: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      bounces: { type: Number, default: 0 },
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
