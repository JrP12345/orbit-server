import jwt from "jsonwebtoken";
import { Organization } from "../models/organization.model.js";

function clearAuthCookies(res) {
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", { path: "/" });
}

export async function authenticate(req, res, next) {
  const { accessToken, refreshToken } = req.cookies || {};

  // 1) Try access token
  if (accessToken) {
    try {
      const decoded = jwt.decode(accessToken);
      if (decoded?.id) {
        const org = await Organization.findById(decoded.id);
        if (org?.publicKey) {
          const payload = jwt.verify(accessToken, org.publicKey, { algorithms: ["RS256"] });

          // Session invalidated by another device?
          if (refreshToken && org.refreshToken !== refreshToken) {
            clearAuthCookies(res);
            return res.status(401).json({ message: "Session invalidated" });
          }

          req.user = payload;
          return next();
        }
      }
    } catch {
      // Access token invalid/expired, try refresh below
    }
  }

  // 2) Try refresh token
  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({ message: "No valid tokens" });
  }

  try {
    const decoded = jwt.decode(refreshToken);
    if (!decoded?.id) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const org = await Organization.findById(decoded.id);
    if (!org?.publicKey || !org?.privateKey) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "User not found" });
    }

    jwt.verify(refreshToken, org.publicKey, { algorithms: ["RS256"] });

    if (org.refreshToken !== refreshToken || !org.refreshTokenExpires || org.refreshTokenExpires < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ message: "Refresh token expired" });
    }

    // Issue new tokens
    const rememberMe = !!org.rememberMe;
    const payload = { id: org._id, email: org.email, name: org.name };

    const newAccessToken = jwt.sign(payload, org.privateKey, { algorithm: "RS256", expiresIn: "15m" });
    const refreshExpires = rememberMe
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 2 * 60 * 60 * 1000);
    const newRefreshToken = jwt.sign(payload, org.privateKey, {
      algorithm: "RS256",
      expiresIn: Math.floor((refreshExpires.getTime() - Date.now()) / 1000),
    });

    org.refreshToken = newRefreshToken;
    org.refreshTokenExpires = refreshExpires;
    await org.save();

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      path: "/",
    };
    res.cookie("accessToken", newAccessToken, { ...cookieOpts, maxAge: 15 * 60 * 1000 });
    res.cookie("refreshToken", newRefreshToken, {
      ...cookieOpts,
      maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000,
    });

    req.user = payload;
    return next();
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ message: "Authentication failed" });
  }
}
