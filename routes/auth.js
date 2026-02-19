import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Organization } from "../models/organization.model.js";
import { User } from "../models/user.model.js";
import { Client } from "../models/client.model.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { sendResetPasswordEmail } from "../lib/email.js";
import { generateKeys, issueTokens, setAuthCookies, clearAuthCookies } from "../lib/auth.js";
import { resolveEntity, buildUserPayload, buildUserResponse, resolvePermissions } from "../middleware/auth.js";
import { getDefaultPlan } from "../lib/plans.js";
import { bootstrapOrgRoles } from "../lib/roles.js";
import { BCRYPT_ROUNDS, normalizeEmail } from "../lib/validate.js";
import { loginEntity, checkEmailAvailable } from "../lib/helpers.js";

const router = express.Router();

router.post("/register", async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.status(403).json({ message: "Registration is only allowed in development environment" });
  }
  try {
    const { name, ownerName, email, password, address, phone, country, businessEmail, website } = req.body;
    if (!name?.trim() || !ownerName?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: "Organization name, owner name, email, and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const validEmail = normalizeEmail(email);
    if (!validEmail) return res.status(400).json({ message: "Invalid email address" });

    const emailErr = await checkEmailAvailable(validEmail);
    if (emailErr) return res.status(409).json({ message: emailErr });

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { privateKey, publicKey } = generateKeys();
    const defaultPlan = await getDefaultPlan();

    const organization = await Organization.create({
      name: name.trim(),
      ownerName: ownerName.trim(),
      email: validEmail,
      password: hashedPassword,
      address: address?.trim() || "",
      phone: phone?.trim() || "",
      country: country?.trim() || "",
      businessEmail: businessEmail?.trim()?.toLowerCase() || "",
      website: website?.trim() || "",
      privateKey,
      publicKey,
      ...(defaultPlan && { planId: defaultPlan._id }),
    });

    await bootstrapOrgRoles(organization._id);

    const payload = buildUserPayload(organization, "organization");
    const tokens = issueTokens(organization.privateKey, payload, false);
    organization.refreshToken = tokens.refreshToken;
    organization.refreshTokenExpires = tokens.refreshExpires;
    await organization.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, false);
    const perms = await resolvePermissions(organization, "organization");

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      user: buildUserResponse(organization, "organization", perms.permissions, perms.roleName),
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email?.trim() || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return res.status(400).json({ message: "Invalid email address" });

    const org = await Organization.findOne({ email: normalizedEmail });
    if (org && (await bcrypt.compare(password, org.password))) {
      return res.json(await loginEntity(res, org, "organization", rememberMe, generateKeys));
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (user && (await bcrypt.compare(password, user.password))) {
      return res.json(await loginEntity(res, user, "user", rememberMe, generateKeys));
    }

    const client = await Client.findOne({ email: normalizedEmail, status: "ACTIVE" });
    if (client && client.password && (await bcrypt.compare(password, client.password))) {
      return res.json(await loginEntity(res, client, "client", rememberMe, generateKeys));
    }

    return res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ message: "Email is required" });

    const safeEmail = normalizeEmail(email);
    if (!safeEmail) return res.status(400).json({ message: "Invalid email address" });

    let entity = await Organization.findOne({ email: safeEmail });
    let entityType = "organization";
    if (!entity) { entity = await User.findOne({ email: safeEmail }); entityType = "user"; }
    if (!entity) { entity = await Client.findOne({ email: safeEmail, status: { $in: ["ACTIVE", "INVITED"] } }); entityType = "client"; }

    if (!entity) {
      return res.json({ success: true, message: "If an account exists with that email, we've sent password reset instructions" });
    }

    const rawToken = generateToken();
    entity.resetToken = hashToken(rawToken);
    entity.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await entity.save();

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const resetLink = `${frontendUrl}/reset-password?token=${rawToken}&type=${entityType}`;
    const emailResult = await sendResetPasswordEmail({ to: entity.email, resetLink });

    return res.json({
      success: true,
      message: "If an account exists with that email, we've sent password reset instructions",
      emailSent: emailResult.success,
      ...(process.env.NODE_ENV === "development" && { resetLink }),
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password, type } = req.body;
    if (!token || !password) return res.status(400).json({ message: "Token and new password are required" });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters" });

    const hashed = hashToken(token);
    const query = { resetToken: hashed, resetTokenExpires: { $gt: new Date() } };

    const models = { organization: Organization, user: User, client: Client };
    let entity = null, entityType = type;

    if (type && models[type]) {
      entity = await models[type].findOne(query);
    } else {
      for (const [t, Model] of Object.entries(models)) {
        entity = await Model.findOne(query);
        if (entity) { entityType = t; break; }
      }
    }

    if (!entity) return res.status(400).json({ message: "Invalid or expired reset link" });

    entity.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
    entity.resetToken = null;
    entity.resetTokenExpires = null;
    entity.refreshToken = null;
    entity.refreshTokenExpires = null;
    await entity.save();

    return res.json({ success: true, message: "Password reset successfully. You can now log in with your new password." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

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
            const perms = await resolvePermissions(result.entity, result.type);
            return res.json({
              authenticated: true,
              user: buildUserResponse(result.entity, result.type, perms.permissions, perms.roleName),
            });
          } catch { /* expired, fall through */ }
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
    const verifyPerms = await resolvePermissions(entity, type);
    return res.json({
      authenticated: true,
      user: buildUserResponse(entity, type, verifyPerms.permissions, verifyPerms.roleName),
    });
  } catch {
    clearAuthCookies(res);
    return res.json({ authenticated: false });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.cookies || {};
    if (refreshToken) {
      const clearFields = { refreshToken: null, refreshTokenExpires: null, rememberMe: false };
      const org = await Organization.findOneAndUpdate({ refreshToken }, clearFields);
      if (!org) {
        const user = await User.findOneAndUpdate({ refreshToken }, clearFields);
        if (!user) await Client.findOneAndUpdate({ refreshToken }, clearFields);
      }
    }
    clearAuthCookies(res);
    return res.json({ success: true });
  } catch {
    clearAuthCookies(res);
    return res.json({ success: true });
  }
});

export default router;
