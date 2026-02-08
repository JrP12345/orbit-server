import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { sendResetPasswordEmail } from "../lib/email.js";
import {
  generateKeys,
  issueTokens,
  setAuthCookies,
  clearAuthCookies,
} from "../lib/auth.js";
import {
  resolveEntity,
  buildUserPayload,
  buildUserResponse,
} from "../middleware/auth.js";

const router = express.Router();

/* ─── Routes ─── */

// Registration (dev only)
router.post("/register", async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.status(403).json({ message: "Registration is only allowed in development environment" });
  }
  try {
    const { name, ownerName, email, password, address, phone } = req.body;
    if (!name || !ownerName || !email || !password || !phone) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (await Organization.findOne({ email })) {
      return res.status(409).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const { privateKey, publicKey } = generateKeys();
    
    const organization = await Organization.create({
      name,
      ownerName,
      email,
      password: hashedPassword,
      address,
      phone,
      privateKey,
      publicKey,
    });

    return res.status(201).json({
      message: "User registered successfully",
      user: { id: organization._id, name: organization.name, email: organization.email },
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Login (supports Organization owner + invited User)
router.post("/login", async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    // 1) Try Organization (owner) login
    const org = await Organization.findOne({ email });
    if (org && (await bcrypt.compare(password, org.password))) {
      if (!org.privateKey || !org.publicKey) {
        const { privateKey, publicKey } = generateKeys();
        org.privateKey = privateKey;
        org.publicKey = publicKey;
      }

      const payload = buildUserPayload(org, "organization");

      const tokens = issueTokens(org.privateKey, payload, rememberMe);
      org.refreshToken = tokens.refreshToken;
      org.refreshTokenExpires = tokens.refreshExpires;
      org.rememberMe = !!rememberMe;
      await org.save();

      setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);

      return res.json({
        success: true,
        message: "Login successful",
        user: buildUserResponse(org, "organization"),
      });
    }

    // 2) Try User (invited member) login
    const user = await User.findOne({ email });
    if (user && (await bcrypt.compare(password, user.password))) {
      if (!user.privateKey || !user.publicKey) {
        const { privateKey, publicKey } = generateKeys();
        user.privateKey = privateKey;
        user.publicKey = publicKey;
      }

      const payload = buildUserPayload(user, "user");

      const tokens = issueTokens(user.privateKey, payload, rememberMe);
      user.refreshToken = tokens.refreshToken;
      user.refreshTokenExpires = tokens.refreshExpires;
      user.rememberMe = !!rememberMe;
      await user.save();

      setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);

      return res.json({
        success: true,
        message: "Login successful",
        user: buildUserResponse(user, "user"),
      });
    }

    // Neither found
    return res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Forgot password — sends reset link via email
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res.status(400).json({ message: "Email is required" });

    // Find account in either collection
    let entity = await Organization.findOne({ email: email.toLowerCase() });
    let entityType = "organization";
    if (!entity) {
      entity = await User.findOne({ email: email.toLowerCase() });
      entityType = "user";
    }

    // Always respond success (don't reveal whether email exists)
    if (!entity) {
      return res.json({
        success: true,
        message: "If an account exists with that email, we've sent password reset instructions",
      });
    }

    // Generate reset token (expires in 1 hour)
    const rawToken = generateToken();
    const hashed = hashToken(rawToken);

    entity.resetToken = hashed;
    entity.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await entity.save();

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const resetLink = `${frontendUrl}/reset-password?token=${rawToken}&type=${entityType}`;

    const emailResult = await sendResetPasswordEmail({
      to: entity.email,
      resetLink,
    });

    // In dev or if email fails, return the link for manual use
    const devOrFailed = process.env.NODE_ENV === "development" || !emailResult.success;

    return res.json({
      success: true,
      message: emailResult.success
        ? "If an account exists with that email, we've sent password reset instructions"
        : "Reset link generated but email delivery failed",
      emailSent: emailResult.success,
      ...(devOrFailed && { resetLink }),
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Reset password — validates token and sets new password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password, type } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const hashed = hashToken(token);

    // Find entity with valid reset token
    let entity = null;
    let entityType = type;

    if (type === "user") {
      entity = await User.findOne({
        resetToken: hashed,
        resetTokenExpires: { $gt: new Date() },
      });
      entityType = "user";
    } else if (type === "organization") {
      entity = await Organization.findOne({
        resetToken: hashed,
        resetTokenExpires: { $gt: new Date() },
      });
      entityType = "organization";
    } else {
      // No type provided — try both
      entity = await Organization.findOne({
        resetToken: hashed,
        resetTokenExpires: { $gt: new Date() },
      });
      entityType = "organization";
      if (!entity) {
        entity = await User.findOne({
          resetToken: hashed,
          resetTokenExpires: { $gt: new Date() },
        });
        entityType = "user";
      }
    }

    if (!entity) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    // Update password and clear reset token
    entity.password = await bcrypt.hash(password, 10);
    entity.resetToken = null;
    entity.resetTokenExpires = null;
    // Invalidate all sessions
    entity.refreshToken = null;
    entity.refreshTokenExpires = null;
    await entity.save();

    return res.json({
      success: true,
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Verify authentication (for frontend page refresh)
router.post("/verify", async (req, res) => {
  const { accessToken, refreshToken } = req.cookies || {};

  if (!accessToken && !refreshToken) {
    clearAuthCookies(res);
    return res.json({ authenticated: false });
  }

  try {
    // 1) Try access token
    if (accessToken) {
      const decoded = jwt.decode(accessToken);
      if (decoded?.id) {
        const result = await resolveEntity(decoded);
        if (result?.entity?.publicKey) {
          try {
            jwt.verify(accessToken, result.entity.publicKey, { algorithms: ["RS256"] });
            if (refreshToken && result.entity.refreshToken !== refreshToken) {
              clearAuthCookies(res);
              return res.json({ authenticated: false });
            }
            return res.json({
              authenticated: true,
              user: buildUserResponse(result.entity, result.type),
            });
          } catch {
            // Access token expired, fall through to refresh
          }
        }
      }
    }

    // 2) Try refresh token
    if (!refreshToken) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    const decoded = jwt.decode(refreshToken);
    if (!decoded?.id) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    const result = await resolveEntity(decoded);
    if (!result?.entity?.publicKey || !result?.entity?.privateKey) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    const { entity, type } = result;

    try {
      jwt.verify(refreshToken, entity.publicKey, { algorithms: ["RS256"] });
    } catch {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    if (entity.refreshToken !== refreshToken || !entity.refreshTokenExpires || entity.refreshTokenExpires < new Date()) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    // Issue new token pair
    const rememberMe = !!entity.rememberMe;
    const payload = buildUserPayload(entity, type);
    const tokens = issueTokens(entity.privateKey, payload, rememberMe);
    entity.refreshToken = tokens.refreshToken;
    entity.refreshTokenExpires = tokens.refreshExpires;
    await entity.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);
    return res.json({
      authenticated: true,
      user: buildUserResponse(entity, type),
    });
  } catch {
    clearAuthCookies(res);
    return res.json({ authenticated: false });
  }
});

// Logout (supports both Organization and User)
router.post("/logout", async (req, res) => {
  const { refreshToken } = req.cookies || {};
  if (refreshToken) {
    // Try Organization first
    const org = await Organization.findOneAndUpdate(
      { refreshToken },
      { refreshToken: null, refreshTokenExpires: null, rememberMe: false }
    );
    // If not found, try User
    if (!org) {
      await User.findOneAndUpdate(
        { refreshToken },
        { refreshToken: null, refreshTokenExpires: null, rememberMe: false }
      );
    }
  }
  clearAuthCookies(res);
  return res.json({ success: true });
});

export default router;
