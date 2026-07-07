import mongoose, { Schema, Document } from "mongoose";

export interface IEmailEvent extends Document {
  campaign_id?: mongoose.Types.ObjectId;
  automation_id?: mongoose.Types.ObjectId;
  reminder_id?: mongoose.Types.ObjectId;
  recipient_email: string;
  /** Which channel this event belongs to — defaults to "email" for all pre-existing rows. */
  channel: "email" | "whatsapp";
  event_type: "sent" | "delivered" | "open" | "click" | "bounce" | "complaint" | "unsubscribe";
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
    automation_id: { type: Schema.Types.ObjectId, ref: "EmailAutomation", index: true },
    reminder_id: { type: Schema.Types.ObjectId, ref: "WebinarReminder", index: true },
    recipient_email: { type: String, required: true, index: true },
    channel: { type: String, enum: ["email", "whatsapp"], default: "email", index: true },
    event_type: {
      type: String, 
      enum: ["sent", "delivered", "open", "click", "bounce", "complaint", "unsubscribe"], 
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
EmailEventSchema.index({ timestamp: -1 });

export default mongoose.models.EmailEvent || mongoose.model<IEmailEvent>("EmailEvent", EmailEventSchema);
