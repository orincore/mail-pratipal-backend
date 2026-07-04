import mongoose, { Schema, Document } from "mongoose";

export interface IEmailTemplate extends Document {
  name: string;
  subject?: string;
  html_content: string;
  design_json?: Record<string, any> | string; // Drag and drop builder state
  type: "builder" | "html" | "text";
  created_at: Date;
  updated_at: Date;
}

const EmailTemplateSchema = new Schema<IEmailTemplate>(
  {
    name: { type: String, required: true },
    subject: { type: String },
    html_content: { type: String, required: true },
    design_json: { type: Schema.Types.Mixed },
    type: { type: String, enum: ["builder", "html", "text"], default: "builder" },
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

export default mongoose.models.EmailTemplate || mongoose.model<IEmailTemplate>("EmailTemplate", EmailTemplateSchema);
