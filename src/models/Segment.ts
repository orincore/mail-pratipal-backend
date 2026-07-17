import mongoose, { Schema, Document } from "mongoose";

export type SegmentRuleField =
  | "status"
  | "list"
  | "tag"
  | "opened_last_days"
  | "clicked_last_days"
  | "not_opened_last_days"
  | "created_last_days";

export type SegmentRuleOperator = "is" | "is_not";

export interface ISegmentRule {
  field: SegmentRuleField;
  /** Only meaningful for status/list/tag rules; engagement/recency rules always use "is". */
  operator: SegmentRuleOperator;
  /** Status name, list name, tag name — or number of days for the *_last_days fields. */
  value: string;
}

export interface ISegment extends Document {
  name: string;
  description?: string;
  /** "all" = every rule must match (AND); "any" = at least one rule matches (OR). */
  match: "all" | "any";
  rules: ISegmentRule[];
  created_at: Date;
  updated_at: Date;
}

const SegmentRuleSchema = new Schema<ISegmentRule>(
  {
    field: {
      type: String,
      enum: [
        "status",
        "list",
        "tag",
        "opened_last_days",
        "clicked_last_days",
        "not_opened_last_days",
        "created_last_days",
      ],
      required: true,
    },
    operator: { type: String, enum: ["is", "is_not"], default: "is" },
    value: { type: String, required: true },
  },
  { _id: false }
);

const SegmentSchema = new Schema<ISegment>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    match: { type: String, enum: ["all", "any"], default: "all" },
    rules: {
      type: [SegmentRuleSchema],
      validate: {
        validator: (rules: ISegmentRule[]) => rules.length > 0,
        message: "A segment needs at least one rule",
      },
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

export default mongoose.models.Segment || mongoose.model<ISegment>("Segment", SegmentSchema);
