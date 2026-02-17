import express from "express";
import { Requirement, VALID_PRIORITIES, VALID_REQ_STATUSES } from "../models/requirement.model.js";
import { Task } from "../models/task.model.js";
import { Client } from "../models/client.model.js";
import { User } from "../models/user.model.js";
import { Organization } from "../models/organization.model.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permission.js";
import { uploadFile, deleteFile, getPresignedUrl } from "../lib/storage.js";
import { createUpload } from "../lib/multerConfig.js";

const upload = createUpload(10);
const router = express.Router();

router.post("/list", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
      const { clientId, status, priority } = req.body || {};

      const filter = { organizationId };
      if (clientId) filter.clientId = clientId;
      if (status && VALID_REQ_STATUSES.includes(status)) filter.status = status;
      if (priority && VALID_PRIORITIES.includes(priority)) filter.priority = priority;

      const requirements = await Requirement.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      // Batch-resolve client names
      const clientIds = [...new Set(requirements.map((r) => r.clientId.toString()))];
      const clients = await Client.find({ _id: { $in: clientIds } })
        .select("name contactName")
        .lean();
      const clientMap = Object.fromEntries(
        clients.map((c) => [c._id.toString(), { name: c.name, contactName: c.contactName }])
      );

      // Count linked tasks and resolve latest task status
      const allLinkedTaskIds = requirements.flatMap((r) => r.linkedTaskIds || []);
      let taskStatusMap = {};
      if (allLinkedTaskIds.length > 0) {
        const tasks = await Task.find({ _id: { $in: allLinkedTaskIds } })
          .select("_id title status")
          .lean();
        taskStatusMap = Object.fromEntries(
          tasks.map((t) => [t._id.toString(), { title: t.title, status: t.status }])
        );
      }

      const formatted = requirements.map((r) => {
        const cInfo = clientMap[r.clientId.toString()] || {};
        const linkedTasks = (r.linkedTaskIds || []).map((id) => {
          const t = taskStatusMap[id.toString()];
          return t ? { id: id.toString(), title: t.title, status: t.status } : { id: id.toString(), title: "Unknown", status: "UNKNOWN" };
        });

        return {
          id: r._id,
          clientId: r.clientId,
          clientName: cInfo.name || "Unknown",
          clientContactName: cInfo.contactName || "",
          title: r.title,
          description: r.description,
          priority: r.priority,
          status: r.status,
          linkedTasks,
          attachmentsCount: (r.attachments || []).length,
          commentsCount: (r.comments || []).length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      });

      return res.json({ success: true, requirements: formatted, total: formatted.length });
    } catch (error) {
      console.error("List requirements error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/detail", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const { requirementId } = req.body;
      const organizationId = req.user.organizationId;

      if (!requirementId) {
        return res.status(400).json({ message: "requirementId is required" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId,
      }).lean();

      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      // Resolve client name
      const client = await Client.findById(requirement.clientId)
        .select("name contactName")
        .lean();

      // Resolve linked task details
      let linkedTasks = [];
      if (requirement.linkedTaskIds && requirement.linkedTaskIds.length > 0) {
        const tasks = await Task.find({ _id: { $in: requirement.linkedTaskIds } })
          .select("title status assignedTo createdAt updatedAt")
          .lean();

        // Batch-resolve assignee names
        const allAssignees = tasks.flatMap((t) => t.assignedTo || []);
        const users = await User.find({ _id: { $in: allAssignees } })
          .select("name")
          .lean();
        const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u.name]));

        linkedTasks = tasks.map((t) => ({
          id: t._id,
          title: t.title,
          status: t.status,
          assignedTo: (t.assignedTo || []).map((id) => ({
            id: id.toString(),
            name: userMap[id.toString()] || "Unknown",
          })),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        }));
      }

      return res.json({
        success: true,
        requirement: {
          id: requirement._id,
          clientId: requirement.clientId,
          clientName: client?.name || "Unknown",
          clientContactName: client?.contactName || "",
          title: requirement.title,
          description: requirement.description,
          priority: requirement.priority,
          status: requirement.status,
          linkedTasks,
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
  }
);

router.post("/comment", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const { requirementId, message } = req.body;
      const organizationId = req.user.organizationId;

      if (!requirementId || !message?.trim()) {
        return res.status(400).json({ message: "requirementId and message are required" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId,
      });

      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      // Determine byType and byName based on who's making the comment
      const byType = req.user.userType === "organization" ? "organization" : "user";
      let byName = req.user.name || "";

      // If it's an organization owner, resolve name
      if (byType === "organization") {
        const org = await Organization.findById(req.user.id).select("ownerName").lean();
        byName = org?.ownerName || req.user.name || "Team";
      }

      const comment = {
        by: req.user.id,
        byName,
        byType,
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
      console.error("Add requirement comment error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/update-status", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const { requirementId, status } = req.body;
      const organizationId = req.user.organizationId;

      if (!requirementId) {
        return res.status(400).json({ message: "requirementId is required" });
      }
      if (!status || !VALID_REQ_STATUSES.includes(status)) {
        return res.status(400).json({
          message: `Status must be one of: ${VALID_REQ_STATUSES.join(", ")}`,
        });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId,
      });

      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      const oldStatus = requirement.status;
      requirement.status = status;
      await requirement.save();

      return res.json({
        success: true,
        message: `Requirement status changed from ${oldStatus} to ${status}`,
        requirement: {
          id: requirement._id,
          status: requirement.status,
        },
      });
    } catch (error) {
      console.error("Update requirement status error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/upload", authenticate, requirePermission("PAGE_CLIENTS"), upload.array("files", 10), async (req, res) => {
    try {
      const { requirementId } = req.body;
      const organizationId = req.user.organizationId;

      if (!requirementId) {
        return res.status(400).json({ message: "requirementId is required" });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files provided" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId,
      });
      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      // Determine uploader name
      let uploaderName = req.user.name || "";
      if (req.user.userType === "organization") {
        const org = await Organization.findById(req.user.id).select("ownerName").lean();
        uploaderName = org?.ownerName || req.user.name || "Team";
      }
      const uploaderType = req.user.userType === "organization" ? "organization" : "user";

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
          uploadedBy: req.user.id,
          uploadedByName: uploaderName,
          uploadedByType: uploaderType,
          at: new Date(),
        };
        requirement.attachments.push(att);
        uploaded.push(att);
      }

      await requirement.save();
      return res.json({ success: true, message: `${uploaded.length} file(s) uploaded`, attachments: uploaded });
    } catch (error) {
      console.error("Requirement upload error:", error);
      return res.status(500).json({ message: error.message || "Upload failed" });
    }
  }
);

router.post("/attachment", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const { requirementId, key } = req.body;
      if (!requirementId || !key) {
        return res.status(400).json({ message: "requirementId and key are required" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId: req.user.organizationId,
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
      console.error("Requirement attachment URL error:", error);
      return res.status(500).json({ message: "Failed to generate download URL" });
    }
  }
);

router.post("/attachment/delete", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
    try {
      const { requirementId, key } = req.body;
      if (!requirementId || !key) {
        return res.status(400).json({ message: "requirementId and key are required" });
      }

      const requirement = await Requirement.findOne({
        _id: requirementId,
        organizationId: req.user.organizationId,
      });
      if (!requirement) {
        return res.status(404).json({ message: "Requirement not found" });
      }

      const idx = requirement.attachments.findIndex((a) => a.key === key);
      if (idx === -1) {
        return res.status(404).json({ message: "Attachment not found" });
      }

      await deleteFile(key);
      requirement.attachments.splice(idx, 1);
      await requirement.save();

      return res.json({ success: true, message: "Attachment deleted" });
    } catch (error) {
      console.error("Delete requirement attachment error:", error);
      return res.status(500).json({ message: "Failed to delete attachment" });
    }
  }
);

export default router;
