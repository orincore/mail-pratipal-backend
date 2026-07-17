import { Router, Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import Segment from "../models/Segment";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailCampaign from "../models/EmailCampaign";
import { buildSubscriberQueryForSegment } from "../lib/segment-query";

const router = Router();

router.use(authMiddleware);

const VALID_RULE_FIELDS = [
  "status",
  "list",
  "tag",
  "opened_last_days",
  "clicked_last_days",
  "not_opened_last_days",
  "created_last_days",
];

function sanitizeRules(rules: any): { rules?: any[]; error?: string } {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { error: "A segment needs at least one rule" };
  }
  const clean = [];
  for (const rule of rules) {
    if (!VALID_RULE_FIELDS.includes(rule?.field)) {
      return { error: `Unknown rule field: ${rule?.field}` };
    }
    if (!rule.value || String(rule.value).trim().length === 0) {
      return { error: "Every rule needs a value" };
    }
    if (String(rule.field).endsWith("_days") && !(parseInt(rule.value, 10) > 0)) {
      return { error: "Day-based rules need a positive number of days" };
    }
    clean.push({
      field: rule.field,
      operator: rule.operator === "is_not" ? "is_not" : "is",
      value: String(rule.value).trim(),
    });
  }
  return { rules: clean };
}

// GET /api/segments - List all segments with live audience counts
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const segments = await Segment.find().sort({ created_at: -1 });

    const withCounts = await Promise.all(
      segments.map(async (segment: any) => {
        let count = 0;
        try {
          const query = await buildSubscriberQueryForSegment(segment);
          count = await EmailSubscriber.countDocuments({ $and: [{ status: "subscribed" }, query] });
        } catch (err) {
          console.error(`Segment count failed for ${segment._id}:`, err);
        }
        const json = segment.toJSON();
        return { ...json, subscriber_count: count };
      })
    );

    return res.json(withCounts);
  } catch (error: any) {
    console.error("GET segments error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/segments - Create a segment
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, match, rules } = req.body;

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({ error: "Segment name is required" });
    }

    const sanitized = sanitizeRules(rules);
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }

    const segment = await Segment.create({
      name: String(name).trim(),
      description,
      match: match === "any" ? "any" : "all",
      rules: sanitized.rules,
    });

    return res.json({ success: true, segment });
  } catch (error: any) {
    console.error("POST segment error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/segments - Update a segment
router.put("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, name, description, match, rules } = req.body;

    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Segment ID is required" });
    }

    const segment = await Segment.findById(id);
    if (!segment) {
      return res.status(404).json({ error: "Segment not found" });
    }

    if (name !== undefined) {
      if (String(name).trim().length === 0) {
        return res.status(400).json({ error: "Segment name cannot be empty" });
      }
      segment.name = String(name).trim();
    }
    if (description !== undefined) segment.description = description;
    if (match !== undefined) segment.match = match === "any" ? "any" : "all";
    if (rules !== undefined) {
      const sanitized = sanitizeRules(rules);
      if (sanitized.error) {
        return res.status(400).json({ error: sanitized.error });
      }
      segment.rules = sanitized.rules as any;
    }

    await segment.save();
    return res.json({ success: true, segment });
  } catch (error: any) {
    console.error("PUT segment error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/segments - Delete a segment (blocked while campaigns reference it)
router.delete("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Segment ID is required" });
    }

    const inUse = await EmailCampaign.countDocuments({
      "audience.segment_id": id,
      status: { $in: ["draft", "scheduled", "sending", "paused"] },
    });
    if (inUse > 0) {
      return res.status(400).json({
        error: `This segment is used by ${inUse} active/draft campaign(s). Update those campaigns first.`,
      });
    }

    const segment = await Segment.findByIdAndDelete(id);
    if (!segment) {
      return res.status(404).json({ error: "Segment not found" });
    }

    return res.json({ success: true, message: "Segment deleted successfully" });
  } catch (error: any) {
    console.error("DELETE segment error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/segments/preview - Evaluate rules without saving (used by the builder UI)
router.post("/preview", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { match, rules } = req.body;

    const sanitized = sanitizeRules(rules);
    if (sanitized.error) {
      return res.status(400).json({ error: sanitized.error });
    }

    const pseudoSegment: any = { match: match === "any" ? "any" : "all", rules: sanitized.rules };
    const query = await buildSubscriberQueryForSegment(pseudoSegment);

    const fullQuery = { $and: [{ status: "subscribed" }, query] };
    const count = await EmailSubscriber.countDocuments(fullQuery);
    const sample = await EmailSubscriber.find(fullQuery)
      .sort({ created_at: -1 })
      .limit(10)
      .select("email first_name last_name status lists tags");

    return res.json({ count, sample });
  } catch (error: any) {
    console.error("POST segment preview error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
