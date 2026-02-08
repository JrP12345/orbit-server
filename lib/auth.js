import jwt from "jsonwebtoken";

/* ─── Cookie Options ─── */

export const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV !== "development",
  sameSite: "lax",
  path: "/",
};

/* ─── Cookie Helpers ─── */

export function setAuthCookies(res, accessToken, refreshToken, rememberMe) {
  res.cookie("accessToken", accessToken, {
    ...COOKIE_OPTS,
    maxAge: 15 * 60 * 1000,
  });
  res.cookie("refreshToken", refreshToken, {
    ...COOKIE_OPTS,
    maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", { path: "/" });
}

/* ─── Token Issuance ─── */

export function issueTokens(privateKey, payload, rememberMe) {
  const accessToken = jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: "15m",
  });
  const refreshExpires = rememberMe
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 2 * 60 * 60 * 1000);
  const refreshToken = jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: Math.floor((refreshExpires.getTime() - Date.now()) / 1000),
  });
  return { accessToken, refreshToken, refreshExpires };
}

/* ─── Key Generation ─── */

import { generateKeyPairSync } from "crypto";

export function generateKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}
