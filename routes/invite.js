import express from "express";
import bcrypt from "bcryptjs";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Invite } from "../models/invite.model.js";
import { authenticate } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import {
  generateKeys,
  issueTokens,
  setAuthCookies,
} from "../lib/auth.js";
import { sendInviteEmail } from "../lib/email.js";

const router = express.Router();

/* ─── POST /api/invites — Create invite (OWNER only, MEMBER role only) ─── */

router.post("/", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { email } = req.body;
    const role = "MEMBER"; // Only MEMBER allowed — one owner per org

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const organizationId = req.user.organizationId;

    // Check if email is the org owner
    const org = await Organization.findById(organizationId);
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }
    if (org.email === email.toLowerCase()) {
      return res
        .status(409)
        .json({ message: "This email is already the organization owner" });
    }

    // Check if email is already a user in the org
    const existingUser = await User.findOne({
      email: email.toLowerCase(),
      organizationId,
    });
    if (existingUser) {
      return res
        .status(409)
        .json({ message: "This email is already a member of your organization" });
    }

    // Check for existing pending invite
    const existingInvite = await Invite.findOne({
      email: email.toLowerCase(),
      organizationId,
      status: "PENDING",
    });
    if (existingInvite) {
      return res
        .status(409)
        .json({ message: "An invite has already been sent to this email" });
    }

    // Generate token
    const rawToken = generateToken();
    const hashedToken = hashToken(rawToken);

    // Create invite (expiresAt = now + 48 hours)
    const invite = await Invite.create({
      organizationId,
      email: email.toLowerCase(),
      role,
      token: hashedToken,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      status: "PENDING",
    });

    // Build invite link
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const inviteLink = `${frontendUrl}/accept-invite?token=${rawToken}`;

    // Send email
    const emailResult = await sendInviteEmail({
      to: email.toLowerCase(),
      inviteLink,
      organizationName: org.name,
      role,
    });

    return res.status(201).json({
      success: true,
      message: emailResult.success
        ? "Invite sent successfully"
        : "Invite created but email delivery failed — share the link manually",
      invite: {
        id: invite._id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        status: invite.status,
      },
      emailSent: emailResult.success,
      // Include link in dev mode OR when email fails (so owner can share manually)
      ...( (process.env.NODE_ENV === "development" || !emailResult.success) && { inviteLink }),
    });
  } catch (error) {
    console.error("Invite creation error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/invites/accept — Accept invite (public) ─── */

router.post("/accept", async (req, res) => {
  try {
    const { token, name, password } = req.body;

    if (!token || !name || !password) {
      return res
        .status(400)
        .json({ message: "Token, name, and password are required" });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters" });
    }

    const hashedToken = hashToken(token);

    const invite = await Invite.findOne({ token: hashedToken });
    if (!invite) {
      return res.status(404).json({ message: "Invalid invite link" });
    }

    if (invite.status === "ACCEPTED" || invite.acceptedAt) {
      return res
        .status(400)
        .json({ message: "This invite has already been used" });
    }

    if (invite.status === "REVOKED") {
      return res
        .status(400)
        .json({ message: "This invite has been revoked" });
    }

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ message: "This invite has expired" });
    }

    // Check if user already exists with this email
    const existingUser = await User.findOne({ email: invite.email });
    if (existingUser) {
      return res
        .status(409)
        .json({ message: "A user with this email already exists" });
    }

    const existingOrg = await Organization.findOne({ email: invite.email });
    if (existingOrg) {
      return res
        .status(409)
        .json({ message: "This email is already registered as an organization owner" });
    }

    // Create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const { privateKey, publicKey } = generateKeys();

    const user = await User.create({
      organizationId: invite.organizationId,
      name,
      email: invite.email,
      password: hashedPassword,
      role: invite.role,
      privateKey,
      publicKey,
    });

    // Mark invite as accepted
    invite.acceptedAt = new Date();
    invite.status = "ACCEPTED";
    await invite.save();

    // Auto-login: issue JWT tokens
    const payload = {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
      userType: "user",
    };

    const tokens = issueTokens(user.privateKey, payload, false);
    user.refreshToken = tokens.refreshToken;
    user.refreshTokenExpires = tokens.refreshExpires;
    await user.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, false);

    return res.json({
      success: true,
      message: "Invite accepted successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  } catch (error) {
    console.error("Accept invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/invites/revoke — Revoke a pending invite (OWNER only) ─── */

router.post("/revoke", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { inviteId } = req.body;

    if (!inviteId) {
      return res.status(400).json({ message: "inviteId is required" });
    }

    const invite = await Invite.findOne({
      _id: inviteId,
      organizationId: req.user.organizationId,
    });

    if (!invite) {
      return res.status(404).json({ message: "Invite not found" });
    }

    if (invite.status !== "PENDING") {
      return res
        .status(400)
        .json({ message: `Cannot revoke — invite is already ${invite.status.toLowerCase()}` });
    }

    invite.status = "REVOKED";
    await invite.save();

    return res.json({
      success: true,
      message: "Invite revoked successfully",
    });
  } catch (error) {
    console.error("Revoke invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/invites/delete — Delete an invite (OWNER only) ─── */

router.post("/delete", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { inviteId } = req.body;

    if (!inviteId) {
      return res.status(400).json({ message: "inviteId is required" });
    }

    const invite = await Invite.findOneAndDelete({
      _id: inviteId,
      organizationId: req.user.organizationId,
    });

    if (!invite) {
      return res.status(404).json({ message: "Invite not found" });
    }

    return res.json({
      success: true,
      message: "Invite deleted successfully",
    });
  } catch (error) {
    console.error("Delete invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/invites/resend — Resend invite email (OWNER only) ─── */

router.post("/resend", authenticate, requireRole("OWNER"), async (req, res) => {
  try {
    const { inviteId } = req.body;

    if (!inviteId) {
      return res.status(400).json({ message: "inviteId is required" });
    }

    const invite = await Invite.findOne({
      _id: inviteId,
      organizationId: req.user.organizationId,
      status: "PENDING",
    });

    if (!invite) {
      return res.status(404).json({ message: "Pending invite not found" });
    }

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ message: "Invite has expired — create a new one instead" });
    }

    // Generate a fresh token (invalidates old link)
    const rawToken = generateToken();
    invite.token = hashToken(rawToken);
    invite.expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await invite.save();

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const inviteLink = `${frontendUrl}/accept-invite?token=${rawToken}`;

    const org = await Organization.findById(req.user.organizationId);

    const emailResult = await sendInviteEmail({
      to: invite.email,
      inviteLink,
      organizationName: org?.name || "your organization",
      role: invite.role,
    });

    return res.json({
      success: true,
      message: emailResult.success
        ? "Invite resent successfully"
        : "New link generated but email delivery failed",
      emailSent: emailResult.success,
      ...( (process.env.NODE_ENV === "development" || !emailResult.success) && { inviteLink }),
    });
  } catch (error) {
    console.error("Resend invite error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─── POST /api/invites/users — List org users & pending invites ─── */

router.post("/users", authenticate, async (req, res) => {
  try {
    const organizationId = req.user.organizationId;

    // Get organization (owner info)
    const org = await Organization.findById(organizationId).select(
      "ownerName email createdAt"
    );
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }

    // Get all users in org
    const users = await User.find({ organizationId }).select(
      "name email role createdAt"
    );

    // Get pending invites (PENDING only, not REVOKED/ACCEPTED)
    const invites = await Invite.find({
      organizationId,
      status: "PENDING",
    }).select("email role expiresAt createdAt status");

    // Combine owner + users
    const allUsers = [
      {
        id: org._id,
        name: org.ownerName,
        email: org.email,
        role: "OWNER",
        type: "owner",
        joinedAt: org.createdAt,
      },
      ...users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        type: "user",
        joinedAt: u.createdAt,
      })),
    ];

    const pendingInvites = invites.map((i) => ({
      id: i._id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      status: i.status,
      expired: i.expiresAt < new Date(),
    }));

    return res.json({
      success: true,
      users: allUsers,
      pendingInvites,
    });
  } catch (error) {
    console.error("Users list error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
