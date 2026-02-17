import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

let s3Client = null;

function getClient() {
  if (!s3Client) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
      throw new Error("Missing R2 config. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME");
    }
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return s3Client;
}

export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv",
  "application/zip", "application/x-rar-compressed",
  "video/mp4", "video/quicktime", "video/webm",
]);

export const MAX_FILE_SIZE = 50 * 1024 * 1024;

let operationCount = 0;
let lastResetDate = new Date().toISOString().slice(0, 7);

function trackOp() {
  const month = new Date().toISOString().slice(0, 7);
  if (month !== lastResetDate) { operationCount = 0; lastResetDate = month; }
  operationCount++;
  if (operationCount === 950_000) {
    console.warn(`R2 free tier warning: ${operationCount} operations this month`);
  }
}

function generateKey(orgId, taskId, originalName) {
  const uuid = crypto.randomUUID();
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${orgId}/${taskId}/${uuid}-${safeName}`;
}

export async function uploadFile(buffer, orgId, taskId, originalName, mimeType) {
  trackOp();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error(`File type "${mimeType}" is not allowed`);
  if (buffer.length > MAX_FILE_SIZE) throw new Error(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`);

  const key = generateKey(orgId, taskId, originalName);
  await getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ContentDisposition: `inline; filename="${originalName}"`,
  }));
  return { key };
}

export async function deleteFile(key) {
  trackOp();
  await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

export async function getPresignedUrl(key, expiresIn = 3600) {
  trackOp();
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }), { expiresIn });
}

export async function deleteFiles(keys) {
  await Promise.all(keys.map((key) => deleteFile(key)));
}

