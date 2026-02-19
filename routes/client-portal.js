import express from "express";
import bcrypt from "bcryptjs";
import { Client } from "../models/client.model.js";
import { Requirement, VALID_PRIORITIES, VALID_REQ_STATUSES } from "../models/requirement.model.js";
import { Task } from "../models/task.model.js";
import { hashToken } from "../lib/crypto.js";
import { generateKeys, issueTokens, setAuthCookies } from "../lib/auth.js";
import { authenticate, buildUserPayload, buildUserResponse, resolvePermissions } from "../middleware/auth.js";
import { syncRequirementStatus } from "./task.js";
import { uploadFile, getPresignedUrl } from "../lib/storage.js";
import { createUpload } from "../lib/multerConfig.js";
import { BCRYPT_ROUNDS } from "../lib/validate.js";

const cpUpload = createUpload(10);
const router = express.Router();

function requireClient(req, res, next) {
  if (!req.user || req.user.userType !== "client") {
    return res.status(403).json({ message: "Client portal access required" });
  }
  next();
}

router.post("/accept-invite", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const hashed = hashToken(token);
    const client = await Client.findOne({
      inviteToken: hashed,
      inviteExpiresAt: { $gt: new Date() },
    });

    if (!client) {
      return res.status(400).json({ message: "Invalid or expired invitation link" });
    }

    // Set up authentication
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { privateKey, publicKey } = generateKeys();

    client.password = hashedPassword;
    client.privateKey = privateKey;
    client.publicKey = publicKey;
    client.status = "ACTIVE";
    client.inviteToken = null;
    client.inviteExpiresAt = null;

    // Auto-login: issue tokens
    const payload = buildUserPayload(client, "client");
    const tokens = issueTokens(client.privateKey, payload, false);
    client.refreshToken = tokens.refreshToken;
    client.refreshTokenExpires = tokens.refreshExpires;
    await client.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, false);

    const perms = await resolvePermissions(client, "client");
    return res.json({
      success: true,
      message: "Account set up successfully",
      user: buildUserResponse(client, "client", perms.permissions, perms.roleName),
    });
  } catch (error) {
    console.error("Accept client invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});


router.post("/dashboard", authenticate, requireClient, async (req, res) => {
  try {
    const { organizationId, clientId } = req.user;

    const [
      openReqs,
      inProgressReqs,
      completedReqs,
      pendingTasks,
      doneTasks,
      totalTasks,
    ] = await Promise.all([
      Requirement.countDocuments({ organizationId, clientId, status: "OPEN" }),
      Requirement.countDocuments({ organizationId, clientId, status: "IN_PROGRESS" }),
      Requirement.countDocuments({ organizationId, clientId, status: { $in: ["COMPLETED", "CLOSED"] } }),
      Task.countDocuments({ organizationId, clientId, status: "SENT_TO_CLIENT" }),
      Task.countDocuments({ organizationId, clientId, status: "DONE" }),
      Task.countDocuments({ organizationId, clientId }),
    ]);

    // Recent requirements
    const recentReqs = await Requirement.find({ organizationId, clientId })
      .sort({ updatedAt: -1 })
      .limit(5)
      .select("title status priority updatedAt")
      .lean();

    // Recent tasks sent to client
    const recentTasks = await Task.find({ organizationId, clientId, status: { $in: ["SENT_TO_CLIENT", "DONE"] } })
      .sort({ updatedAt: -1 })
      .limit(5)
      .select("title status updatedAt")
      .lean();

    return res.json({
      success: true,
      stats: {
        requirements: { open: openReqs, inProgress: inProgressReqs, completed: completedReqs },
        tasks: { pendingReview: pendingTasks, done: doneTasks, total: totalTasks },
      },
      recentRequirements: recentReqs.map((r) => ({
        id: r._id,
        title: r.title,
        status: r.status,
        priority: r.priority,
        updatedAt: r.updatedAt,
      })),
      recentTasks: recentTasks.map((t) => ({
        id: t._id,
        title: t.title,
        status: t.status,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Client dashboard error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/requirements", authenticate, requireClient, async (req, res) => {
  try {
    const { title, description, priority } = req.body;
    const { organizationId, clientId } = req.user;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ message: `Priority must be one of: ${VALID_PRIORITIES.join(", ")}` });
    }

    const requirement = await Requirement.create({
      organizationId,
      clientId,
      title: title.trim(),
      description: description?.trim() || "",
      priority: priority || "MEDIUM",
      status: "OPEN",
      createdBy: clientId,
      comments: [],
    });

    return res.status(201).json({
      success: true,
      message: "Requirement submitted",
      requirement: {
        id: requirement._id,
        title: requirement.title,
        description: requirement.description,
        priority: requirement.priority,
        status: requirement.status,
        createdAt: requirement.createdAt,
      },
    });
  } catch (error) {
    console.error("Create requirement error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/requirements/list", authenticate, requireClient, async (req, res) => {
  try {
    const { organizationId, clientId } = req.user;
    const { status } = req.body || {};

    const filter = { organizationId, clientId };
    if (status && VALID_REQ_STATUSES.includes(status)) {
      filter.status = status;
    }

    const requirements = await Requirement.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    // Resolve linked task details for all requirements
    const allLinkedTaskIds = requirements.flatMap((r) => r.linkedTaskIds || []);
    let taskMap = {};
    if (allLinkedTaskIds.length > 0) {
      const tasks = await Task.find({ _id: { $in: allLinkedTaskIds } })
        .select("_id title status")
        .lean();
      taskMap = Object.fromEntries(
        tasks.map((t) => [t._id.toString(), { title: t.title, status: t.status }])
      );
    }

    const formatted = requirements.map((r) => ({
      id: r._id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      status: r.status,
      linkedTaskIds: r.linkedTaskIds || [],
      linkedTasks: (r.linkedTaskIds || []).map((id) => {
        const t = taskMap[id.toString()];
        return t ? { id: id.toString(), title: t.title, status: t.status } : { id: id.toString(), title: "Unknown", status: "UNKNOWN" };
      }),
      attachmentsCount: (r.attachments || []).length,
      commentsCount: (r.comments || []).length,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    return res.json({ success: true, requirements: formatted });
  } catch (error) {
    console.error("List requirements error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/requirements/detail", authenticate, requireClient, async (req, res) => {
  try {
    const { requirementId } = req.body;
    const { organizationId, clientId } = req.user;

    if (!requirementId) {
      return res.status(400).json({ message: "requirementId is required" });
    }

    const requirement = await Requirement.findOne({
      _id: requirementId,
      organizationId,
      clientId,
    }).lean();

    if (!requirement) {
      return res.status(404).json({ message: "Requirement not found" });
    }

    // Resolve linked task details (title, status) instead of just IDs
    let linkedTasks = [];
    if (requirement.linkedTaskIds && requirement.linkedTaskIds.length > 0) {
      const tasks = await Task.find({ _id: { $in: requirement.linkedTaskIds } })
        .select("title status updatedAt")
        .lean();
      linkedTasks = tasks.map((t) => ({
        id: t._id,
        title: t.title,
        status: t.status,
        updatedAt: t.updatedAt,
      }));
    }

    return res.json({
      success: true,
      requirement: {
        id: requirement._id,
        title: requirement.title,
        description: requirement.description,
        priority: requirement.priority,
        status: requirement.status,
        linkedTasks,
        linkedTaskIds: requirement.linkedTaskIds || [],
        attachments: (requirement.attachments || []).map((a) => ({
          key: a.key,
          name: a.name,
          size: a.size,
          mimeType: a.mimeType,
          uploadedByName: a.uploadedByName || "Unknown",
          uploadedByType: a.uploadedByType || "client",
          at: a.at,
        })),
        comments: (requirement.comments || []).map((c) => ({
          by: c.by,
          byName: c.byName,
          byType: c.byType,
          message: c.message,
          at: c.at,
        })),
        createdAt: requirement.createdAt,
        updatedAt: requirement.updatedAt,
      },
    });
  } catch (error) {
    console.error("Requirement detail error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/requirements/comment", authenticate, requireClient, async (req, res) => {
  try {
    const { requirementId, message } = req.body;
    const { organizationId, clientId, name } = req.user;

    if (!requirementId || !message?.trim()) {
      return res.status(400).json({ message: "requirementId and message are required" });
    }

    const requirement = await Requirement.findOne({
      _id: requirementId,
      organizationId,
      clientId,
    });

    if (!requirement) {
      return res.status(404).json({ message: "Requirement not found" });
    }

    const comment = {
      by: clientId,
      byName: name,
      byType: "client",
      message: message.trim(),
      at: new Date(),
    };

    requirement.comments.push(comment);
    await requirement.save();

    return res.json({
      success: true,
      message: "Comment added",
      comment,
    });
  } catch (error) {
    console.error("Add comment error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post(
  "/requirements/upload",
  authenticate,
  requireClient,
  cpUpload.array("files", 10),
  async (req, res) => {
    try {
      const { requirementId } = req.body;
      const { organizationId, clientId, name } = req.user;

      if (!requirementId) {
        return res.status(400).json({ message: "requirementId is required" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files provided" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId,
        clientId,
      });
      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      const uploaded = [];
      for (const file of req.files) {
        const { key } = await uploadFile(
          file.buffer,
          organizationId.toString(),
          requirementId.toString(),
          file.originalname,
          file.mimetype
        );
        const att = {
          key,
          name: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          uploadedBy: clientId,
          uploadedByName: name || "Client",
          uploadedByType: "client",
          at: new Date(),
        };
        requirement.attachments.push(att);
        uploaded.push(att);
      }

      await requirement.save();
      return res.json({ success: true, message: `${uploaded.length} file(s) uploaded`, attachments: uploaded });
    } catch (error) {
      console.error("Client requirement upload error:", error);
      return res.status(500).json({ message: error.message || "Upload failed" });
    }
  }
);

router.post("/requirements/attachment", authenticate, requireClient, async (req, res) => {
  try {
    const { requirementId, key } = req.body;
    const { organizationId, clientId } = req.user;

    if (!requirementId || !key) {
      return res.status(400).json({ message: "requirementId and key are required" });
    }

    const requirement = await Requirement.findOne({
      _id: requirementId,
      organizationId,
      clientId,
    }).lean();

    if (!requirement) {
      return res.status(404).json({ message: "Requirement not found" });
    }

    const att = (requirement.attachments || []).find((a) => a.key === key);
    if (!att) {
      return res.status(404).json({ message: "Attachment not found" });
    }

    const url = await getPresignedUrl(key);
    return res.json({ success: true, url, name: att.name, mimeType: att.mimeType });
  } catch (error) {
    console.error("Client requirement attachment URL error:", error);
    return res.status(500).json({ message: "Failed to generate download URL" });
  }
});

router.post("/tasks/list", authenticate, requireClient, async (req, res) => {
  try {
    const { organizationId, clientId } = req.user;
    const { statusFilter } = req.body || {}; // optional: "ALL", "SENT_TO_CLIENT", "DONE", etc.

    const filter = { organizationId, clientId };
    if (statusFilter && statusFilter !== "ALL") {
      filter.status = statusFilter;
    }

    const tasks = await Task.find(filter)
      .sort({ updatedAt: -1 })
      .select("title description status assignedTo createdAt updatedAt history attachments")
      .lean();

    const formatted = tasks.map((t) => ({
      id: t._id,
      title: t.title,
      description: t.description,
      status: t.status,
      canRespond: t.status === "SENT_TO_CLIENT",
      attachments: (t.attachments || []).map((a) => ({
        key: a.key,
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        uploadedByName: a.uploadedByName || "Unknown",
        context: a.context || "reference",
        at: a.at,
      })),
      history: (t.history || []).map((h) => ({
        from: h.from,
        to: h.to,
        by: h.by,
        byName: h.byName,
        note: h.note || "",
        at: h.at,
      })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));

    return res.json({ success: true, tasks: formatted });
  } catch (error) {
    console.error("Client tasks list error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/tasks/respond", authenticate, requireClient, async (req, res) => {
  try {
    const { taskId, decision, note } = req.body;
    const { organizationId, clientId, name } = req.user;

    if (!taskId) {
      return res.status(400).json({ message: "taskId is required" });
    }
    if (!["DONE", "REVISION"].includes(decision)) {
      return res.status(400).json({ message: "Decision must be DONE or REVISION" });
    }
    if (decision === "REVISION" && !note?.trim()) {
      return res.status(400).json({ message: "A note is required when requesting changes" });
    }

    const task = await Task.findOne({ _id: taskId, organizationId, clientId });
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    if (task.status !== "SENT_TO_CLIENT") {
      return res.status(400).json({ message: "This task is not awaiting your review" });
    }

    const newStatus = decision === "DONE" ? "DONE" : "REVISION";

    task.history.push({
      from: "SENT_TO_CLIENT",
      to: newStatus,
      by: clientId,
      byName: name || "Client",
      note: note?.trim() || (decision === "DONE" ? "Client approved" : "Client requested changes"),
      at: new Date(),
    });

    task.status = newStatus;
    await task.save();

    // Auto-sync linked requirement status
    await syncRequirementStatus(task._id, newStatus);

    return res.json({
      success: true,
      message: decision === "DONE" ? "Task approved" : "Changes requested",
      task: {
        id: task._id,
        title: task.title,
        status: task.status,
      },
    });
  } catch (error) {
    console.error("Client task respond error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/tasks/attachment", authenticate, requireClient, async (req, res) => {
  try {
    const { taskId, key } = req.body;
    const { organizationId, clientId } = req.user;

    if (!taskId || !key) {
      return res.status(400).json({ message: "taskId and key are required" });
    }

    const task = await Task.findOne({ _id: taskId, organizationId, clientId }).lean();
    if (!task) return res.status(404).json({ message: "Task not found" });

    const attachment = (task.attachments || []).find((a) => a.key === key);
    if (!attachment) {
      return res.status(404).json({ message: "Attachment not found" });
    }

    const url = await getPresignedUrl(key, 3600);

    return res.json({ success: true, url, name: attachment.name, mimeType: attachment.mimeType });
  } catch (error) {
    console.error("Client get attachment URL error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
