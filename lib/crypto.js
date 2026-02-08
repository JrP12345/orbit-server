import { randomBytes, createHash } from "crypto";

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
