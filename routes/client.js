import express from "express";
import { Client } from "../models/client.model.js";
import { Organization } from "../models/organization.model.js";
import { Requirement } from "../models/requirement.model.js";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permission.js";
import { checkClientLimit } from "../lib/clientGuard.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { sendClientInviteEmail } from "../lib/email.js";
import { normalizeEmail } from "../lib/validate.js";
import { checkEmailAvailable } from "../lib/helpers.js";

const router = express.Router();

/* ─── POST /api/clients — Create a new client ─── */

router.post("/", authenticate, requirePermission("PAGE_CLIENTS"), requirePermission("CLIENT_MANAGE"), async (req, res) => {
  try {
    const { name, contactName, email } = req.body;
    const organizationId = req.user.organizationId;

    if (!name || !name.trim()) return res.status(400).json({ message: "Client name is required" });

    const limitCheck = await checkClientLimit(organizationId);
    if (!limitCheck.allowed) {
      return res.status(403).json({
        message: limitCheck.message,
        activeCount: limitCheck.activeCount,
        maxClients: limitCheck.maxClients,
        planName: limitCheck.planName,
      });
    }

    let validatedEmail = null;
    if (email && email.trim()) {
      validatedEmail = normalizeEmail(email);
      if (!validatedEmail) return res.status(400).json({ message: "Invalid email address" });
      const emailErr = await checkEmailAvailable(validatedEmail);
      if (emailErr) return res.status(409).json({ message: emailErr });
    }

    // Build client data
    const clientData = {
      organizationId,
      name: name.trim(),
      contactName: contactName?.trim() || "",
      status: validatedEmail ? "INVITED" : "ACTIVE",
    };

    // If email provided, generate invite token and set email
    let inviteLink = null;
    if (validatedEmail) {
      clientData.email = validatedEmail;
      const rawToken = generateToken();
      clientData.inviteToken = hashToken(rawToken);
      clientData.inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      inviteLink = `${frontendUrl}/accept-client-invite?token=${rawToken}`;
    }

    const client = await Client.create(clientData);

    // Send invite email if applicable
    let emailSent = false;
    if (validatedEmail && inviteLink) {
      const org = await Organization.findById(organizationId).select("name").lean();
      const emailResult = await sendClientInviteEmail({
        to: validatedEmail,
        inviteLink,
        organizationName: org?.name || "Your organization",
        contactName: clientData.contactName,
      });
      emailSent = emailResult.success;
    }

    return res.status(201).json({
      success: true,
      message: validatedEmail
        ? (emailSent ? "Client created and invitation sent" : "Client created but invitation email failed")
        : "Client created successfully",
      client: {
        id: client._id,
        name: client.name,
        contactName: client.contactName,
        email: client.email || null,
        status: client.status,
        createdAt: client.createdAt,
      },
      emailSent,
      usage: {
        activeCount: limitCheck.activeCount + 1,
        maxClients: limitCheck.maxClients,
        planName: limitCheck.planName,
      },
    });
  } catch (error) {
    console.error("Create client error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ message: "This email is already in use" });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/clients/list ─── */

router.post("/list", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
  try {
    const organizationId = req.user.organizationId;

    const clients = await Client.find({ organizationId })
      .select("name contactName email status createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const formatted = clients.map((c) => ({
      id: c._id,
      name: c.name,
      contactName: c.contactName || "",
      email: c.email || "",
      status: c.status,
      hasPortalAccess: !!(c.email && c.status === "ACTIVE"),
      createdAt: c.createdAt,
    }));

    // Include usage info
    const limitCheck = await checkClientLimit(organizationId);

    return res.json({
      success: true,
      clients: formatted,
      usage: {
        activeCount: limitCheck.activeCount ?? 0,
        maxClients: limitCheck.maxClients ?? 0,
        planName: limitCheck.planName ?? "FREE",
      },
    });
  } catch (error) {
    console.error("List clients error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/clients/update ─── */

router.post("/update", authenticate, requirePermission("PAGE_CLIENTS"), requirePermission("CLIENT_MANAGE"), async (req, res) => {
  try {
    const { clientId, name, status } = req.body;
    const organizationId = req.user.organizationId;

    if (!clientId) {
      return res.status(400).json({ message: "clientId is required" });
    }

    const client = await Client.findOne({ _id: clientId, organizationId });
    if (!client) {
      return res.status(404).json({ message: "Client not found in your organization" });
    }

    // Update name
    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ message: "Client name cannot be empty" });
      }
      client.name = name.trim();
    }

    // Update contact name
    if (req.body.contactName !== undefined) {
      client.contactName = req.body.contactName.trim();
    }

    // Update email
    if (req.body.email !== undefined) {
      const newEmail = normalizeEmail(req.body.email);
      if (req.body.email && !newEmail) return res.status(400).json({ message: "Invalid email address" });
      if (newEmail && newEmail !== client.email) {
        const emailErr = await checkEmailAvailable(newEmail, client._id);
        if (emailErr) return res.status(409).json({ message: emailErr });
        client.email = newEmail;
      }
    }

    // Update status
    if (status !== undefined) {
      if (!["ACTIVE", "ARCHIVED"].includes(status)) {
        return res.status(400).json({ message: "Status must be ACTIVE or ARCHIVED" });
      }

      // Check plan limit before reactivation
      if (status === "ACTIVE" && client.status === "ARCHIVED") {
        const limitCheck = await checkClientLimit(organizationId);
        if (!limitCheck.allowed) {
          return res.status(403).json({
            message: limitCheck.message,
            activeCount: limitCheck.activeCount,
            maxClients: limitCheck.maxClients,
            planName: limitCheck.planName,
          });
        }
      }

      client.status = status;
    }

    await client.save();

    return res.json({
      success: true,
      message: `Client ${client.status === "ARCHIVED" ? "archived" : "updated"} successfully`,
      client: {
        id: client._id,
        name: client.name,
        contactName: client.contactName || "",
        email: client.email || "",
        status: client.status,
        createdAt: client.createdAt,
      },
    });
  } catch (error) {
    console.error("Update client error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/clients/resend-invite ─── */

router.post("/resend-invite", authenticate, requirePermission("PAGE_CLIENTS"), requirePermission("CLIENT_MANAGE"), async (req, res) => {
  try {
    const { clientId } = req.body;
    const organizationId = req.user.organizationId;

    if (!clientId) {
      return res.status(400).json({ message: "clientId is required" });
    }

    const client = await Client.findOne({ _id: clientId, organizationId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    if (!client.email) {
      return res.status(400).json({ message: "Client has no email address set" });
    }
    if (client.status === "ARCHIVED") {
      return res.status(400).json({ message: "Cannot invite an archived client" });
    }
    if (client.password) {
      return res.status(400).json({ message: "Client already has portal access" });
    }

    // Generate new invite token
    const rawToken = generateToken();
    client.inviteToken = hashToken(rawToken);
    client.inviteExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    client.status = "INVITED";
    await client.save();

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const inviteLink = `${frontendUrl}/accept-client-invite?token=${rawToken}`;

    const org = await Organization.findById(organizationId).select("name").lean();
    const emailResult = await sendClientInviteEmail({
      to: client.email,
      inviteLink,
      organizationName: org?.name || "Your organization",
      contactName: client.contactName,
    });

    return res.json({
      success: true,
      message: emailResult.success ? "Invitation resent" : "Invite generated but email failed",
      emailSent: emailResult.success,
      ...(process.env.NODE_ENV === "development" && { inviteLink }),
    });
  } catch (error) {
    console.error("Resend invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/clients/requirements ─── */

router.post("/requirements", authenticate, requirePermission("PAGE_CLIENTS"), async (req, res) => {
  try {
    const { clientId } = req.body;
    const organizationId = req.user.organizationId;

    if (!clientId) {
      return res.status(400).json({ message: "clientId is required" });
    }

    const requirements = await Requirement.find({ organizationId, clientId })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = requirements.map((r) => ({
      id: r._id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      status: r.status,
      linkedTaskIds: r.linkedTaskIds || [],
      commentsCount: (r.comments || []).length,
      createdAt: r.createdAt,
    }));

    return res.json({ success: true, requirements: formatted });
  } catch (error) {
    console.error("List requirements error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
