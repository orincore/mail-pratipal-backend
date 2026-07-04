import mongoose, { Schema, Document } from "mongoose";

export interface IAutomationStep {
  id: string;
  type: "email" | "delay" | "condition";
  email_config?: {
    template_id: string;
    subject: string;
    sender_name: string;
    sender_email: string;
  };
  delay_config?: {
    duration: number;
    unit: "minutes" | "hours" | "days";
  };
  condition_config?: {
    field: "open" | "click" | "tag"; // Event type or status condition
    operator: "equals" | "contains" | "true" | "false";
    value: string;
    yes_step_id?: string;
    no_step_id?: string;
  };
  next_step_id?: string;
}

export interface IAutomationEnrollment {
  subscriber_id: mongoose.Types.ObjectId;
  current_step_id: string;
  next_run_at: Date;
  status: "active" | "completed" | "failed";
  history: Array<{
    step_id: string;
    executed_at: Date;
    status: "success" | "failed";
    details?: string;
  }>;
}

export interface IEmailAutomation extends Document {
  name: string;
  trigger: {
    type: "api" | "manual" | "event";
    event_name?: string; // e.g. "webinar_registration"
  };
  steps: IAutomationStep[];
  enrollments: IAutomationEnrollment[];
  status: "active" | "draft" | "paused";
  stats: {
    enrolled: number;
    completed: number;
  };
  created_at: Date;
  updated_at: Date;
}

const AutomationStepSchema = new Schema<IAutomationStep>({
  id: { type: String, required: true },
  type: { type: String, enum: ["email", "delay", "condition"], required: true },
  email_config: {
    template_id: { type: String },
    subject: { type: String },
    sender_name: { type: String },
    sender_email: { type: String },
  },
  delay_config: {
    duration: { type: Number },
    unit: { type: String, enum: ["minutes", "hours", "days"] },
  },
  condition_config: {
    field: { type: String, enum: ["open", "click", "tag"] },
    operator: { type: String, enum: ["equals", "contains", "true", "false"] },
    value: { type: String },
    yes_step_id: { type: String },
    no_step_id: { type: String },
  },
  next_step_id: { type: String },
});

const AutomationEnrollmentSchema = new Schema<IAutomationEnrollment>({
  subscriber_id: { type: Schema.Types.ObjectId, ref: "EmailSubscriber", required: true, index: true },
  current_step_id: { type: String, required: true },
  next_run_at: { type: Date, required: true, index: true },
  status: { type: String, enum: ["active", "completed", "failed"], default: "active" },
  history: [
    {
      step_id: { type: String, required: true },
      executed_at: { type: Date, default: Date.now },
      status: { type: String, enum: ["success", "failed"], required: true },
      details: { type: String },
    },
  ],
});

const EmailAutomationSchema = new Schema<IEmailAutomation>(
  {
    name: { type: String, required: true },
    trigger: {
      type: { type: String, enum: ["api", "manual", "event"], required: true },
      event_name: { type: String },
    },
    steps: [AutomationStepSchema],
    enrollments: [AutomationEnrollmentSchema],
    status: { type: String, enum: ["active", "draft", "paused"], default: "draft", index: true },
    stats: {
      enrolled: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
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

export default mongoose.models.EmailAutomation || mongoose.model<IEmailAutomation>("EmailAutomation", EmailAutomationSchema);
