import mongoose, { Schema, Document } from "mongoose";

export interface IEmailSubscriber extends Document {
  email?: string;
  first_name?: string;
  last_name?: string;
  whatsapp_number?: string;
  status: "subscribed" | "unsubscribed" | "bounced" | "complained" | "pending";
  /**
   * WhatsApp-specific opt-out — deliberately separate from `status`, which is
   * an EMAIL deliverability/consent flag (see fan-out.ts's
   * pendingSubscribersForLeg and queue-processor.ts's
   * resolveAudienceSubscribers for the full rationale: reusing `status` for
   * WhatsApp used to silently drop recipients over an unrelated email event).
   * Set when this number replies "stop" to a WhatsApp message — see
   * routes/whatsapp.ts's POST /webhook.
   */
  whatsapp_opted_out?: boolean;
  whatsapp_opted_out_at?: Date;
  lists: string[]; // List IDs/Names
  tags: string[];
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

const EmailSubscriberSchema = new Schema<IEmailSubscriber>(
  {
    email: { type: String, required: false, unique: true, sparse: true, index: true, lowercase: true, trim: true },
    first_name: { type: String },
    last_name: { type: String },
    whatsapp_number: { type: String },
    status: { type: String, enum: ["subscribed", "unsubscribed", "bounced", "complained", "pending"], default: "subscribed" },
    whatsapp_opted_out: { type: Boolean, default: false, index: true },
    whatsapp_opted_out_at: { type: Date },
    lists: [{ type: String, index: true }],
    tags: [{ type: String, index: true }],
    metadata: { type: Map, of: Schema.Types.Mixed },
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

export default mongoose.models.EmailSubscriber || mongoose.model<IEmailSubscriber>("EmailSubscriber", EmailSubscriberSchema);
