import mongoose from "mongoose";

/* ─── Constants ─── */

/** Consistent bcrypt salt rounds across the entire application */
export const BCRYPT_ROUNDS = 12;

/* ─── Validators ─── */

/**
 * Validate a MongoDB ObjectId string.
 * Returns true if the string is a valid 24-char hex ObjectId.
 */
export function isValidObjectId(id) {
  if (!id) return false;
  return (
    mongoose.Types.ObjectId.isValid(id) &&
    String(new mongoose.Types.ObjectId(id)) === String(id)
  );
}

/** RFC 5322 simplified email regex */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate and normalize an email address.
 * Returns the lowercase, trimmed email or null if invalid.
 */
export function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.toLowerCase().trim();
  if (!trimmed || !EMAIL_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * Require a non-empty trimmed string.
 * Returns the trimmed string or null if empty / exceeds maxLength.
 */
export function requireTrimmed(value, maxLength = 500) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}
