import mongoose, { Schema, Document } from "mongoose";

export interface IEmailSubscriber extends Document {
  email?: string;
  first_name?: string;
  last_name?: string;
  whatsapp_number?: string;
  status: "subscribed" | "unsubscribed" | "bounced" | "complained" | "pending";
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
