import mongoose, { Schema, Document } from "mongoose";

export interface IEmailSender extends Document {
  email: string;
  verification_status: "pending" | "verified" | "failed";
  created_at: Date;
  updated_at: Date;
}

const EmailSenderSchema = new Schema<IEmailSender>(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    verification_status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
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

export default mongoose.models.EmailSender || mongoose.model<IEmailSender>("EmailSender", EmailSenderSchema);
