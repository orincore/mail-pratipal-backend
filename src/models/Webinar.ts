import mongoose, { Schema, Document } from "mongoose";

// Mirrors one InvitationWindow from the main website — one specific occurrence
// of a (possibly reused) webinar landing page. Keyed by source_window_id, not
// by landing page, since the same landing page/slug can have many separate
// occurrences, each needing its own registrant list and reminder schedule.
export interface IWebinar extends Document {
  source_window_id: string;
  slug: string;
  title: string;
  starts_at: Date;
  timezone: string;
  status: "upcoming" | "completed" | "cancelled";
  registration_start?: Date;
  registration_end?: Date;
  join_link?: string;
  join_platform?: "zoom" | "google_meet" | "teams" | "other";
  last_synced_at?: Date;
  created_at: Date;
  updated_at: Date;
}

const WebinarSchema = new Schema<IWebinar>(
  {
    source_window_id: { type: String, required: true, unique: true },
    slug: { type: String, required: true, index: true },
    title: { type: String, required: true },
    starts_at: { type: Date, required: true, index: true },
    timezone: { type: String, default: "Asia/Kolkata" },
    status: {
      type: String,
      enum: ["upcoming", "completed", "cancelled"],
      default: "upcoming",
      index: true,
    },
    registration_start: { type: Date },
    registration_end: { type: Date },
    join_link: { type: String },
    join_platform: { type: String, enum: ["zoom", "google_meet", "teams", "other"] },
    last_synced_at: { type: Date },
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

delete (mongoose.models as any).Webinar;

export default mongoose.model<IWebinar>("Webinar", WebinarSchema);
