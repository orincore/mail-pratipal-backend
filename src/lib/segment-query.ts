import mongoose from "mongoose";
import EmailEvent from "../models/EmailEvent";
import Webinar from "../models/Webinar";
import { ISegment, ISegmentRule } from "../models/Segment";
import { webinarTag } from "./webinar-sync";

// A webinar's own Mongo _id (not registered against a raw source_window_id
// nobody in the segment builder UI would ever type by hand) that means
// "any webinar" rather than one specific one — see the "webinar" rule below.
export const ANY_WEBINAR_VALUE = "__any__";

/**
 * Translates a saved segment into a MongoDB query over EmailSubscriber.
 *
 * Engagement rules (opened/clicked in the last N days) are resolved via a
 * distinct() over EmailEvent first, then folded into the subscriber query as
 * an $in/$nin over email — one indexed pre-query per engagement rule.
 */
export async function buildSubscriberQueryForSegment(segment: ISegment): Promise<Record<string, any>> {
  const clauses: Record<string, any>[] = [];

  for (const rule of segment.rules) {
    clauses.push(await buildRuleClause(rule));
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];

  return segment.match === "any" ? { $or: clauses } : { $and: clauses };
}

async function buildRuleClause(rule: ISegmentRule): Promise<Record<string, any>> {
  const negate = rule.operator === "is_not";

  switch (rule.field) {
    case "status":
      return { status: negate ? { $ne: rule.value } : rule.value };

    case "list":
      return negate ? { lists: { $ne: rule.value } } : { lists: rule.value };

    case "tag":
      return negate ? { tags: { $ne: rule.value } } : { tags: rule.value };

    // "All participants of <webinar>" — rule.value is a Webinar._id (or
    // ANY_WEBINAR_VALUE for "registered for any webinar at all"), resolved
    // to its registrant tag the same way campaign audience resolution does
    // (see resolveAudienceSubscribers in queue-processor.ts). Works for both
    // real, window-backed webinars and the synthetic "page:<slug>" ones a
    // page with no window gets (GET /api/integrations/webinars on the
    // website) — this rule doesn't care which kind it is.
    case "webinar": {
      let tagList: string[];
      if (rule.value === ANY_WEBINAR_VALUE) {
        const webinars = await Webinar.find().select("source_window_id");
        tagList = webinars.map((w: any) => webinarTag(w));
      } else if (mongoose.isValidObjectId(rule.value)) {
        const webinar = await Webinar.findById(rule.value).select("source_window_id");
        tagList = webinar ? [webinarTag(webinar)] : [];
      } else {
        tagList = []; // malformed value — deleted webinar or a stale/bad reference
      }
      if (tagList.length === 0) return { _id: { $exists: false } }; // deleted/unknown webinar — match nothing
      return negate ? { tags: { $nin: tagList } } : { tags: { $in: tagList } };
    }

    // "Windowed participants for all landing pages" — is/is_not a registrant
    // of a REAL, window-backed occurrence anywhere, as opposed to one of the
    // synthetic "page:<slug>" entries a page with no window gets. Mirrors the
    // per-page "All Participants" tab's exclusion logic, but system-wide
    // across every landing page at once rather than scoped to one. rule.value
    // isn't used — the schema just requires a non-empty string.
    case "windowed": {
      const webinars = await Webinar.find().select("source_window_id");
      const realTags = webinars
        .filter((w: any) => !String(w.source_window_id).startsWith("page:"))
        .map((w: any) => webinarTag(w));
      if (realTags.length === 0) {
        // No real windows exist anywhere — "is windowed" matches nobody;
        // "is not windowed" matches everybody.
        return negate ? {} : { _id: { $exists: false } };
      }
      return negate ? { tags: { $nin: realTags } } : { tags: { $in: realTags } };
    }

    case "created_last_days": {
      const since = daysAgo(rule.value);
      return negate ? { created_at: { $lt: since } } : { created_at: { $gte: since } };
    }

    case "opened_last_days":
    case "clicked_last_days":
    case "not_opened_last_days": {
      const since = daysAgo(rule.value);
      const eventType = rule.field === "clicked_last_days" ? "click" : "open";
      const emails: string[] = await EmailEvent.find({
        event_type: eventType,
        timestamp: { $gte: since },
      }).distinct("recipient_email");

      const wantEngaged = rule.field !== "not_opened_last_days" ? !negate : negate;
      return wantEngaged ? { email: { $in: emails } } : { email: { $nin: emails } };
    }

    default:
      // Unknown rule fields match nothing rather than silently matching everyone.
      return { _id: { $exists: false } };
  }
}

function daysAgo(value: string): Date {
  const days = Math.max(1, parseInt(value, 10) || 1);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
