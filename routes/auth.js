import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "crypto";
import { Organization } from "../models/organization.model.js";

const router = express.Router();

/* ─── Shared Helpers ─── */

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV !== "development",
  sameSite: "lax",
  path: "/",
};

function setAuthCookies(res, accessToken, refreshToken, rememberMe) {
  res.cookie("accessToken", accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie("refreshToken", refreshToken, {
    ...COOKIE_OPTS,
    maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000,
  });
}

function clearAuthCookies(res) {
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", { path: "/" });
}

function generateKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function issueTokens(org, rememberMe) {
  const payload = { id: org._id, email: org.email, name: org.name };
  const accessToken = jwt.sign(payload, org.privateKey, { algorithm: "RS256", expiresIn: "15m" });
  const refreshExpires = rememberMe
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 2 * 60 * 60 * 1000);
  const refreshToken = jwt.sign(payload, org.privateKey, {
    algorithm: "RS256",
    expiresIn: Math.floor((refreshExpires.getTime() - Date.now()) / 1000),
  });
  return { accessToken, refreshToken, refreshExpires };
}

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
      name, ownerName, email,
      password: hashedPassword,
      address, phone,status: "Active",createdAt: new Date(),
      privateKey, publicKey,
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

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const org = await Organization.findOne({ email });
    if (!org || !(await bcrypt.compare(password, org.password)))
      return res.status(401).json({ message: "Invalid email or password" });

    // Generate keys if missing (backward compatibility)
    if (!org.privateKey || !org.publicKey) {
      const { privateKey, publicKey } = generateKeys();
      org.privateKey = privateKey;
      org.publicKey = publicKey;
    }

    const tokens = issueTokens(org, rememberMe);
    org.refreshToken = tokens.refreshToken;
    org.refreshTokenExpires = tokens.refreshExpires;
    org.rememberMe = !!rememberMe;
    await org.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);

    return res.json({
      success: true,
      message: "Login successful",
      user: { id: org._id, name: org.name, email: org.email },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Forgot password route
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res.status(400).json({ message: "Email is required" });

  const user = await Organization.findOne({ email });
  if (!user)
    return res.status(404).json({ message: "No account with that email" });

  // Simulate success (implement email logic as needed)
  return res.json({
    success: true,
    message: "Password reset instructions sent to your email",
  });
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
        const org = await Organization.findById(decoded.id);
        if (org?.publicKey) {
          try {
            jwt.verify(accessToken, org.publicKey, { algorithms: ["RS256"] });
            // Session invalidated by another device?
            if (refreshToken && org.refreshToken !== refreshToken) {
              clearAuthCookies(res);
              return res.json({ authenticated: false });
            }
            return res.json({ authenticated: true, user: { id: org._id, name: org.name, email: org.email } });
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

    const org = await Organization.findById(decoded.id);
    if (!org?.publicKey || !org?.privateKey) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    try {
      jwt.verify(refreshToken, org.publicKey, { algorithms: ["RS256"] });
    } catch {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    if (org.refreshToken !== refreshToken || !org.refreshTokenExpires || org.refreshTokenExpires < new Date()) {
      clearAuthCookies(res);
      return res.json({ authenticated: false });
    }

    // Issue new token pair
    const rememberMe = !!org.rememberMe;
    const tokens = issueTokens(org, rememberMe);
    org.refreshToken = tokens.refreshToken;
    org.refreshTokenExpires = tokens.refreshExpires;
    await org.save();

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, rememberMe);
    return res.json({ authenticated: true, user: { id: org._id, name: org.name, email: org.email } });
  } catch {
    clearAuthCookies(res);
    return res.json({ authenticated: false });
  }
});

// Logout
router.post("/logout", async (req, res) => {
  const { refreshToken } = req.cookies || {};
  if (refreshToken) {
    await Organization.findOneAndUpdate(
      { refreshToken },
      { refreshToken: null, refreshTokenExpires: null, rememberMe: false }
    );
  }
  clearAuthCookies(res);
  return res.json({ success: true });
});

export default router;
