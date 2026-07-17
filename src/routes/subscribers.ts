import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import EmailSubscriber from "../models/EmailSubscriber";
import EmailEvent from "../models/EmailEvent";
import mongoose from "mongoose";

const router = Router();

// Apply auth middleware to all routes in this file
router.use(authMiddleware);

const SUPPRESSED_STATUSES = ["bounced", "complained", "unsubscribed"];

// GET /api/subscribers - List subscribers (paginated)
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const search = (req.query.search as string) || "";
    const list = (req.query.list as string) || "";
    const tag = (req.query.tag as string) || "";
    const status = (req.query.status as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const query: any = {};

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: "i" } },
        { first_name: { $regex: search, $options: "i" } },
        { last_name: { $regex: search, $options: "i" } },
      ];
    }

    if (list) {
      query.lists = list;
    }

    if (tag) {
      query.tags = tag;
    }

    if (status) {
      query.status = status;
    }

    const total = await EmailSubscriber.countDocuments(query);
    const subscribers = await EmailSubscriber.find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Aggregate unique lists and tags for filtering UI
    const allLists = await EmailSubscriber.distinct("lists");
    const allTags = await EmailSubscriber.distinct("tags");

    return res.json({
      subscribers,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      lists: allLists.filter(Boolean),
      tags: allTags.filter(Boolean),
    });
  } catch (error: any) {
    console.error("GET subscribers error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/subscribers/suppressions - Suppressed recipients with their latest failure reason
router.get("/suppressions", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = (req.query.status as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const query: any = {
      status: status && SUPPRESSED_STATUSES.includes(status) ? status : { $in: SUPPRESSED_STATUSES },
    };

    const total = await EmailSubscriber.countDocuments(query);
    const subscribers = await EmailSubscriber.find(query)
      .sort({ updated_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Attach each subscriber's latest suppression-relevant event for context
    const emails = subscribers.map((s: any) => s.email).filter(Boolean);
    const lastEvents = await EmailEvent.aggregate([
      {
        $match: {
          recipient_email: { $in: emails },
          event_type: { $in: ["bounce", "complaint", "unsubscribe", "failed"] },
        },
      },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$recipient_email",
          event_type: { $first: "$event_type" },
          timestamp: { $first: "$timestamp" },
          details: { $first: "$details" },
        },
      },
    ]);
    const eventByEmail = new Map(lastEvents.map((e: any) => [e._id, e]));

    const counts = await EmailSubscriber.aggregate([
      { $match: { status: { $in: SUPPRESSED_STATUSES } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const countByStatus: Record<string, number> = { bounced: 0, complained: 0, unsubscribed: 0 };
    for (const row of counts) countByStatus[row._id] = row.count;

    return res.json({
      subscribers: subscribers.map((s: any) => ({
        ...s,
        id: s._id.toString(),
        last_event: eventByEmail.get(s.email) || null,
      })),
      counts: countByStatus,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error: any) {
    console.error("GET suppressions error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/subscribers/suppressions/reactivate - Move a suppressed contact back to subscribed
router.post("/suppressions/reactivate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.body;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Subscriber ID is required" });
    }

    const subscriber = await EmailSubscriber.findById(id);
    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }
    if (!SUPPRESSED_STATUSES.includes(subscriber.status)) {
      return res.status(400).json({ error: "Subscriber is not suppressed" });
    }

    subscriber.status = "subscribed";
    await subscriber.save();

    return res.json({ success: true, subscriber });
  } catch (error: any) {
    console.error("POST reactivate error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/subscribers - Create subscriber
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email, first_name, last_name, whatsapp_number, status = "subscribed", lists = [], tags = [], metadata = {} } = req.body;

    if (!email && !whatsapp_number) {
      return res.status(400).json({ error: "Either Email or WhatsApp number is required" });
    }

    let cleanEmail = undefined;
    if (email) {
      cleanEmail = email.toLowerCase().trim();
      // Check if email already exists
      const exists = await EmailSubscriber.exists({ email: cleanEmail });
      if (exists) {
        return res.status(400).json({ error: "Subscriber email already exists" });
      }
    }

    const subscriber = await EmailSubscriber.create({
      email: cleanEmail,
      first_name,
      last_name,
      whatsapp_number,
      status,
      lists,
      tags,
      metadata,
    });

    return res.json({ success: true, subscriber });
  } catch (error: any) {
    console.error("POST subscriber error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /api/subscribers - Update subscriber
router.put("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, ...updateFields } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Subscriber ID is required" });
    }

    if (updateFields.email) {
      updateFields.email = updateFields.email.toLowerCase().trim();
    }

    const subscriber = await EmailSubscriber.findByIdAndUpdate(id, updateFields, { new: true });
    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    return res.json({ success: true, subscriber });
  } catch (error: any) {
    console.error("PUT subscriber error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/subscribers - Delete subscriber
router.delete("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.query.id as string;

    if (!id) {
      return res.status(400).json({ error: "Subscriber ID is required" });
    }

    const subscriber = await EmailSubscriber.findByIdAndDelete(id);
    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    return res.json({ success: true, message: "Subscriber deleted successfully" });
  } catch (error: any) {
    console.error("DELETE subscriber error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/subscribers/import - Import contacts
router.post("/import", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { subscribers, defaultLists = [], defaultTags = [] } = req.body;

    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: "No subscribers data provided" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const ops = [];

    for (const sub of subscribers) {
      if (!sub.email || !emailRegex.test(sub.email)) {
        continue;
      }

      const email = sub.email.toLowerCase().trim();
      const first_name = sub.first_name || sub.firstName || "";
      const last_name = sub.last_name || sub.lastName || "";

      const rowLists = Array.isArray(sub.lists) ? sub.lists : (sub.lists ? [sub.lists] : []);
      const rowTags = Array.isArray(sub.tags) ? sub.tags : (sub.tags ? [sub.tags] : []);

      const combinedLists = Array.from(new Set([...rowLists, ...defaultLists])).filter(Boolean);
      const combinedTags = Array.from(new Set([...rowTags, ...defaultTags])).filter(Boolean);

      ops.push({
        updateOne: {
          filter: { email },
          update: {
            $set: {
              first_name,
              last_name,
              status: "subscribed",
            },
            $addToSet: {
              lists: { $each: combinedLists },
              tags: { $each: combinedTags },
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return res.status(400).json({ error: "No valid subscriber records found in payload" });
    }

    const bulkWriteResult = await EmailSubscriber.bulkWrite(ops);

    return res.json({
      success: true,
      importedCount: bulkWriteResult.upsertedCount + bulkWriteResult.modifiedCount,
      inserted: bulkWriteResult.upsertedCount,
      updated: bulkWriteResult.modifiedCount,
    });
  } catch (error: any) {
    console.error("Bulk import API error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/subscribers/sync-customers - Sync customers from main storefront collection
router.post("/sync-customers", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Database connection not established");
    }

    const customersCollection = db.collection("customers");
    const customers = await customersCollection.find().toArray();

    if (customers.length === 0) {
      return res.json({
        success: true,
        message: "No storefront customers found to sync.",
        syncedCount: 0,
      });
    }

    const ops = [];
    const syncList = "Storefront Customers";
    const syncTag = "storefront";

    for (const cust of customers) {
      if (!cust.email) continue;

      const email = cust.email.toLowerCase().trim();
      const first_name = cust.first_name || "";
      const last_name = cust.last_name || "";

      ops.push({
        updateOne: {
          filter: { email },
          update: {
            $setOnInsert: {
              first_name,
              last_name,
              status: "subscribed",
            },
            $addToSet: {
              lists: syncList,
              tags: syncTag,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return res.status(400).json({ error: "No valid customer records found" });
    }

    const result = await EmailSubscriber.bulkWrite(ops);

    return res.json({
      success: true,
      message: `Successfully synchronized customers.`,
      syncedCount: result.upsertedCount + result.modifiedCount,
      inserted: result.upsertedCount,
      updated: result.modifiedCount,
      totalCustomers: customers.length,
    });
  } catch (error: any) {
    console.error("Sync customers API error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/subscribers/:id - Single subscriber profile
router.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid subscriber ID" });
    }

    const subscriber = await EmailSubscriber.findById(id);
    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    return res.json({ subscriber });
  } catch (error: any) {
    console.error("GET subscriber error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/subscribers/:id/activity - Paginated event history for one subscriber
router.get("/:id/activity", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid subscriber ID" });
    }

    const subscriber = await EmailSubscriber.findById(id);
    if (!subscriber) {
      return res.status(404).json({ error: "Subscriber not found" });
    }

    if (!subscriber.email) {
      return res.json({ subscriber, events: [], total: 0, page: 1, pages: 1 });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const type = (req.query.type as string) || "";

    const query: any = { recipient_email: subscriber.email.toLowerCase() };
    if (type) query.event_type = type;

    const total = await EmailEvent.countDocuments(query);
    const events = await EmailEvent.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("campaign_id", "name")
      .populate("reminder_id", "name");

    return res.json({
      subscriber,
      events,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error: any) {
    console.error("GET subscriber activity error:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
