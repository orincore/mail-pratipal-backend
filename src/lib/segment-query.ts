import EmailEvent from "../models/EmailEvent";
import { ISegment, ISegmentRule } from "../models/Segment";

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
