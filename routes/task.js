import express from "express";
import { Task, VALID_TASK_STATUSES } from "../models/task.model.js";
import { Requirement } from "../models/requirement.model.js";
import { Client } from "../models/client.model.js";
import { User } from "../models/user.model.js";
import { Organization } from "../models/organization.model.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permission.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../lib/storage.js";
import { createUpload } from "../lib/multerConfig.js";
import { resolveActorName, resolveActorNames } from "../lib/helpers.js";

const router = express.Router();
const upload = createUpload(10);

const TRANSITIONS = {
  TODO: [{ to: "DOING", permission: null, label: "Start" }],
  DOING: [{ to: "READY_FOR_REVIEW", permission: null, label: "Submit for Review" }],
  READY_FOR_REVIEW: [
    { to: "SENT_TO_CLIENT", permission: "TASK_SEND_TO_CLIENT", label: "Send to Client" },
    { to: "REVISION", permission: "TASK_REVIEW", label: "Request Changes" },
  ],
  SENT_TO_CLIENT: [
    { to: "DONE", permission: "TASK_CLIENT_DECISION", label: "Client Approved" },
    { to: "REVISION", permission: "TASK_CLIENT_DECISION", label: "Client Rejected" },
  ],
  REVISION: [{ to: "DOING", permission: null, label: "Start Rework" }],
  DONE: [],
};

router.post(
  "/",
  authenticate,
  requirePermission("TASK_CREATE"),
  requirePermission("PAGE_TASKS"),
  async (req, res) => {
    try {
      const { clientId, title, description, assignedTo, requirementId } = req.body;
      const organizationId = req.user.organizationId;

      if (!clientId) return res.status(400).json({ message: "clientId is required" });
      if (!title?.trim()) return res.status(400).json({ message: "Title is required" });

      const client = await Client.findOne({ _id: clientId, organizationId, status: { $in: ["ACTIVE", "INVITED"] } });
      if (!client) {
        return res.status(404).json({ message: "Active client not found in your organization" });
      }

      let validAssignees = [];
      if (assignedTo && Array.isArray(assignedTo) && assignedTo.length > 0) {
        const users = await User.find({ _id: { $in: assignedTo }, organizationId }).select("_id");
        validAssignees = users.map((u) => u._id);

        // Also allow the organization owner to be assigned
        const org = await Organization.findById(organizationId).select("_id").lean();
        if (org && assignedTo.includes(org._id.toString()) && !validAssignees.some(id => id.toString() === org._id.toString())) {
          validAssignees.push(org._id);
        }
      }

      const task = await Task.create({
        organizationId,
        clientId,
        title: title.trim(),
        description: description?.trim() || "",
        assignedTo: validAssignees,
        status: "TODO",
        createdBy: req.user.id,
        history: [],
      });

      // Link task to requirement if provided
      if (requirementId) {
        try {
          const req_ = await Requirement.findOne({ _id: requirementId, organizationId, clientId });
          if (req_) {
            req_.linkedTaskIds.push(task._id);
            if (req_.status === "OPEN") req_.status = "IN_PROGRESS";
            await req_.save();
          }
        } catch (linkErr) {
          console.error("Requirement link error (non-fatal):", linkErr);
        }
      }

      const assigneeMap = await resolveActorNames(validAssignees);

      return res.status(201).json({
        success: true,
        message: "Task created",
        task: formatTask(task, client.name, assigneeMap),
      });
    } catch (error) {
      console.error("Create task error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/list", authenticate, requirePermission("PAGE_TASKS"), async (req, res) => {
  try {
    const organizationId = req.user.organizationId;
    const { clientId, status } = req.body || {};

    const filter = { organizationId };
    if (clientId) filter.clientId = clientId;
    if (status && VALID_TASK_STATUSES.includes(status)) filter.status = status;

    // Visibility: OWNER or TASK_VIEW_ALL sees all, others see assigned + created
    const canSeeAll =
      req.user.role === "OWNER" ||
      (req.user.permissions || []).includes("TASK_VIEW_ALL");
    if (!canSeeAll) {
      filter.$or = [
        { assignedTo: req.user.id },
        { createdBy: req.user.id },
      ];
    }

    const tasks = await Task.find(filter).sort({ createdAt: -1 }).lean();

    // Batch-resolve client names
    const clientIds = [...new Set(tasks.map((t) => t.clientId.toString()))];
    const clients = await Client.find({ _id: { $in: clientIds } }).select("name").lean();
    const clientMap = Object.fromEntries(clients.map((c) => [c._id.toString(), c.name]));

    // Batch-resolve names
    const allUserIds = [
      ...new Set([
        ...tasks.flatMap((t) => (t.assignedTo || []).map((id) => id.toString())),
        ...tasks.map((t) => t.createdBy?.toString()).filter(Boolean),
      ]),
    ];
    const users = await User.find({ _id: { $in: allUserIds } }).select("name email").lean();
    const userMap = Object.fromEntries(
      users.map((u) => [u._id.toString(), { name: u.name, email: u.email }])
    );
    // Resolve missing IDs from Organization
    const missingIds = allUserIds.filter((id) => !userMap[id]);
    if (missingIds.length > 0) {
      const orgs = await Organization.find({ _id: { $in: missingIds } }).select("ownerName email").lean();
      for (const org of orgs) {
        userMap[org._id.toString()] = { name: org.ownerName, email: org.email };
      }
    }

    const formatted = tasks.map((t) => formatTask(t, clientMap[t.clientId.toString()] || "Unknown", userMap));

    return res.json({ success: true, tasks: formatted, total: formatted.length });
  } catch (error) {
    console.error("List tasks error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/detail", authenticate, requirePermission("PAGE_TASKS"), async (req, res) => {
  try {
    const { taskId } = req.body;
    const organizationId = req.user.organizationId;

    if (!taskId) return res.status(400).json({ message: "taskId is required" });

    const task = await Task.findOne({ _id: taskId, organizationId }).lean();
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Visibility check: can see if OWNER, TASK_VIEW_ALL, assigned, or creator
    const canSeeAll =
      req.user.role === "OWNER" ||
      (req.user.permissions || []).includes("TASK_VIEW_ALL");
    if (!canSeeAll) {
      const isAssigned = (task.assignedTo || []).some(
        (id) => id.toString() === req.user.id.toString()
      );
      const isCreator = task.createdBy?.toString() === req.user.id.toString();
      if (!isAssigned && !isCreator) return res.status(403).json({ message: "Access denied" });
    }

    const client = await Client.findById(task.clientId).select("name").lean();
    const assigneeMap = await resolveActorNames(task.assignedTo);

    return res.json({
      success: true,
      task: formatTask(task, client?.name || "Unknown", assigneeMap),
    });
  } catch (error) {
    console.error("Task detail error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post(
  "/update",
  authenticate,
  requirePermission("PAGE_TASKS"),
  requirePermission("TASK_EDIT"),
  async (req, res) => {
    try {
      const { taskId, title, description, assignedTo } = req.body;
      const organizationId = req.user.organizationId;

      if (!taskId) return res.status(400).json({ message: "taskId is required" });

      const task = await Task.findOne({ _id: taskId, organizationId });
      if (!task) return res.status(404).json({ message: "Task not found" });

      if (task.status === "DONE") {
        return res.status(400).json({ message: "Cannot edit a completed task" });
      }

      if (title !== undefined) {
        if (!title.trim()) return res.status(400).json({ message: "Title cannot be empty" });
        task.title = title.trim();
      }
      if (description !== undefined) task.description = description.trim();
      if (assignedTo !== undefined) {
        if (!Array.isArray(assignedTo)) return res.status(400).json({ message: "assignedTo must be an array" });
        const users = await User.find({ _id: { $in: assignedTo }, organizationId }).select("_id");
        const validIds = users.map((u) => u._id);

        // Also allow the organization owner to be assigned
        const org = await Organization.findById(organizationId).select("_id").lean();
        if (org && assignedTo.includes(org._id.toString()) && !validIds.some(id => id.toString() === org._id.toString())) {
          validIds.push(org._id);
        }

        task.assignedTo = validIds;
      }

      await task.save();

      const client = await Client.findById(task.clientId).select("name").lean();
      const assigneeMap = await resolveActorNames(task.assignedTo);

      return res.json({
        success: true,
        message: "Task updated",
        task: formatTask(task, client?.name || "Unknown", assigneeMap),
      });
    } catch (error) {
      console.error("Update task error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);


router.post("/move", authenticate, requirePermission("PAGE_TASKS"), async (req, res) => {
  try {
    const { taskId, status: targetStatus, note } = req.body;
    const organizationId = req.user.organizationId;

    if (!taskId) return res.status(400).json({ message: "taskId is required" });
    if (!targetStatus) return res.status(400).json({ message: "status is required" });
    if (!VALID_TASK_STATUSES.includes(targetStatus)) {
      return res.status(400).json({ message: `Invalid status: ${targetStatus}` });
    }

    const task = await Task.findOne({ _id: taskId, organizationId });
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Find the matching transition
    const allowed = TRANSITIONS[task.status] || [];
    const transition = allowed.find((t) => t.to === targetStatus);
    if (!transition) {
      return res.status(400).json({
        message: `Cannot move from ${task.status} to ${targetStatus}. Allowed: ${
          allowed.map((t) => t.to).join(", ") || "none (terminal)"
        }`,
      });
    }

    // ── Permission check ──
    if (transition.permission) {
      // Gated transition — requires the specific permission
      const hasPerm =
        req.user.role === "OWNER" ||
        (req.user.permissions || []).includes(transition.permission);
      if (!hasPerm) {
        return res.status(403).json({
          message: `You need the ${transition.permission} permission for this action`,
        });
      }
    } else {
      // Standard transition — assignee/creator with TASK_MOVE_OWN, or TASK_VIEW_ALL for any
      const canMoveAny =
        req.user.role === "OWNER" ||
        (req.user.permissions || []).includes("TASK_VIEW_ALL");
      if (!canMoveAny) {
        const hasMoveOwn = (req.user.permissions || []).includes("TASK_MOVE_OWN");
        const isAssigned = (task.assignedTo || []).some(
          (id) => id.toString() === req.user.id.toString()
        );
        const isCreator = task.createdBy?.toString() === req.user.id.toString();
        if (!hasMoveOwn || (!isAssigned && !isCreator)) {
          return res.status(403).json({ message: "You can only update tasks assigned to you" });
        }
      }
    }

    // ── Apply transition ──
    const fromStatus = task.status;
    task.status = targetStatus;

    // Resolve actor name for history
    const actorName = await resolveActorName(req.user.id);

    task.history.push({
      from: fromStatus,
      to: targetStatus,
      by: req.user.id,
      byName: actorName,
      note: note?.trim() || "",
      at: new Date(),
    });

    await task.save();

    // Auto-sync linked requirement status
    await syncRequirementStatus(task._id, targetStatus);

    const client = await Client.findById(task.clientId).select("name").lean();
    const assigneeMap = await resolveActorNames(task.assignedTo);

    return res.json({
      success: true,
      message: `Task moved to ${targetStatus}`,
      task: formatTask(task, client?.name || "Unknown", assigneeMap),
    });
  } catch (error) {
    console.error("Move task error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post(
  "/delete",
  authenticate,
  requirePermission("PAGE_TASKS"),
  requirePermission("TASK_DELETE"),
  async (req, res) => {
    try {
      const { taskId } = req.body;
      const organizationId = req.user.organizationId;

      if (!taskId) return res.status(400).json({ message: "taskId is required" });

      const task = await Task.findOne({ _id: taskId, organizationId });
      if (!task) return res.status(404).json({ message: "Task not found" });

      // Delete all attachments from R2
      if (task.attachments && task.attachments.length > 0) {
        try {
          await Promise.all(task.attachments.map((a) => deleteFile(a.key)));
        } catch (storageErr) {
          console.error("R2 cleanup error (non-fatal):", storageErr);
        }
      }

      // Unlink this task from any requirements that reference it
      await Requirement.updateMany(
        { linkedTaskIds: task._id },
        { $pull: { linkedTaskIds: task._id } }
      );

      await Task.deleteOne({ _id: task._id });

      return res.json({ success: true, message: "Task deleted" });
    } catch (error) {
      console.error("Delete task error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);


router.post(
  "/upload",
  authenticate,
  requirePermission("PAGE_TASKS"),
  upload.array("files", 10),
  async (req, res) => {
    try {
      const { taskId, context } = req.body;
      const organizationId = req.user.organizationId;

      if (!taskId) return res.status(400).json({ message: "taskId is required" });
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files provided" });
      }

      const validContext = ["reference", "deliverable"].includes(context) ? context : "reference";

      const task = await Task.findOne({ _id: taskId, organizationId });
      if (!task) return res.status(404).json({ message: "Task not found" });

      if (task.status === "DONE") {
        return res.status(400).json({ message: "Cannot add attachments to a completed task" });
      }

      // Visibility check
      const canSeeAll =
        req.user.role === "OWNER" ||
        (req.user.permissions || []).includes("TASK_VIEW_ALL");
      if (!canSeeAll) {
        const isAssigned = (task.assignedTo || []).some(
          (id) => id.toString() === req.user.id.toString()
        );
        const isCreator = task.createdBy?.toString() === req.user.id.toString();
        if (!isAssigned && !isCreator) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const uploaderName = await resolveActorName(req.user.id);

      // Upload each file to R2 and save metadata
      const uploaded = [];
      for (const file of req.files) {
        const { key } = await uploadFile(
          file.buffer,
          organizationId.toString(),
          taskId,
          file.originalname,
          file.mimetype
        );

        const attachment = {
          key,
          name: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          uploadedBy: req.user.id,
          uploadedByName: uploaderName,
          context: validContext,
          at: new Date(),
        };

        task.attachments.push(attachment);
        uploaded.push(attachment);
      }

      await task.save();

      return res.json({
        success: true,
        message: `${uploaded.length} file(s) uploaded`,
        attachments: uploaded.map((a) => ({
          key: a.key,
          name: a.name,
          size: a.size,
          mimeType: a.mimeType,
          uploadedBy: a.uploadedBy,
          uploadedByName: a.uploadedByName,
          context: a.context,
          at: a.at,
        })),
      });
    } catch (error) {
      console.error("Upload attachment error:", error);
      if (error.message?.includes("not allowed") || error.message?.includes("exceeds")) {
        return res.status(400).json({ message: error.message });
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/attachment", authenticate, requirePermission("PAGE_TASKS"), async (req, res) => {
  try {
    const { taskId, key } = req.body;
    const organizationId = req.user.organizationId;

    if (!taskId || !key) {
      return res.status(400).json({ message: "taskId and key are required" });
    }

    const task = await Task.findOne({ _id: taskId, organizationId }).lean();
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Visibility check
    const canSeeAll =
      req.user.role === "OWNER" ||
      (req.user.permissions || []).includes("TASK_VIEW_ALL");
    if (!canSeeAll) {
      const isAssigned = (task.assignedTo || []).some(
        (id) => id.toString() === req.user.id.toString()
      );
      const isCreator = task.createdBy?.toString() === req.user.id.toString();
      if (!isAssigned && !isCreator) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    // Verify the key belongs to this task
    const attachment = (task.attachments || []).find((a) => a.key === key);
    if (!attachment) {
      return res.status(404).json({ message: "Attachment not found" });
    }

    const url = await getPresignedUrl(key, 3600); // 1 hour

    return res.json({ success: true, url, name: attachment.name, mimeType: attachment.mimeType });
  } catch (error) {
    console.error("Get attachment URL error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post(
  "/attachment/delete",
  authenticate,
  requirePermission("PAGE_TASKS"),
  requirePermission("TASK_EDIT"),
  async (req, res) => {
    try {
      const { taskId, key } = req.body;
      const organizationId = req.user.organizationId;

      if (!taskId || !key) {
        return res.status(400).json({ message: "taskId and key are required" });
      }

      const task = await Task.findOne({ _id: taskId, organizationId });
      if (!task) return res.status(404).json({ message: "Task not found" });

      if (task.status === "DONE") {
        return res.status(400).json({ message: "Cannot modify attachments on a completed task" });
      }

      const idx = task.attachments.findIndex((a) => a.key === key);
      if (idx === -1) {
        return res.status(404).json({ message: "Attachment not found" });
      }

      // Delete from R2
      try {
        await deleteFile(key);
      } catch (storageErr) {
        console.error("R2 delete error (non-fatal):", storageErr);
      }

      task.attachments.splice(idx, 1);
      await task.save();

      return res.json({ success: true, message: "Attachment deleted" });
    } catch (error) {
      console.error("Delete attachment error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* ── Helpers ── */

export async function syncRequirementStatus(taskId, newTaskStatus) {
  try {
    const requirements = await Requirement.find({ linkedTaskIds: taskId });
    for (const req of requirements) {
      // Guard: don't touch CLOSED requirements (manually closed by team)
      if (req.status === "CLOSED") continue;

      // Resolve all linked task statuses
      const linkedTasks = await Task.find({ _id: { $in: req.linkedTaskIds } })
        .select("status")
        .lean();

      const allDone = linkedTasks.length > 0 && linkedTasks.every((t) => t.status === "DONE");
      const anyInProgress = linkedTasks.some((t) =>
        ["DOING", "READY_FOR_REVIEW", "SENT_TO_CLIENT", "REVISION"].includes(t.status)
      );

      if (allDone && req.status !== "COMPLETED") {
        req.status = "COMPLETED";
        await req.save();
      } else if (anyInProgress && req.status === "OPEN") {
        req.status = "IN_PROGRESS";
        await req.save();
      } else if (anyInProgress && req.status === "COMPLETED") {
        // A task was reopened — move back to IN_PROGRESS
        req.status = "IN_PROGRESS";
        await req.save();
      }
    }
  } catch (err) {
    console.error("Sync requirement status error (non-fatal):", err);
  }
}

function formatTask(task, clientName, assigneeMap, creatorName = "") {
  const doc = task._doc || task; // handle both mongoose & lean docs
  return {
    id: doc._id,
    clientId: doc.clientId,
    clientName,
    title: doc.title,
    description: doc.description || "",
    status: doc.status,
    assignedTo: (doc.assignedTo || []).map((id) => ({
      id: id.toString(),
      name: assigneeMap[id.toString()]?.name || "Unknown",
      email: assigneeMap[id.toString()]?.email || "",
    })),
    attachments: (doc.attachments || []).map((a) => ({
      key: a.key,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      uploadedBy: a.uploadedBy,
      uploadedByName: a.uploadedByName || "Unknown",
      context: a.context || "reference",
      at: a.at,
    })),
    history: (doc.history || []).map((h) => ({
      from: h.from,
      to: h.to,
      by: h.by,
      byName: h.byName || "Unknown",
      note: h.note || "",
      at: h.at,
    })),
    createdBy: doc.createdBy,
    createdByName: creatorName || assigneeMap[doc.createdBy?.toString()]?.name || "Unknown",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export default router;
