import multer from "multer";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from "./storage.js";

/**
 * Create a multer upload middleware with the app's standard file validation.
 *
 * Centralised config so we don't duplicate multer setup across routes.
 * Memory storage is used because files go straight to R2 (no local disk needed).
 *
 * @param {number} maxFiles - Maximum files per request (default: 10)
 */
export function createUpload(maxFiles = 10) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: maxFiles },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type "${file.mimetype}" is not allowed`));
      }
    },
  });
}
