import mongoose, { Schema, Document } from "mongoose";

export interface IEmailDomain extends Document {
  domain: string;
  verification_token: string;
  verification_status: "pending" | "verified" | "failed";
  dkim_tokens: string[];
  dkim_status: "pending" | "verified" | "failed";
  created_at: Date;
  updated_at: Date;
}

const EmailDomainSchema = new Schema<IEmailDomain>(
  {
    domain: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    verification_token: { type: String, required: true },
    verification_status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
    dkim_tokens: [{ type: String }],
    dkim_status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
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

export default mongoose.models.EmailDomain || mongoose.model<IEmailDomain>("EmailDomain", EmailDomainSchema);
