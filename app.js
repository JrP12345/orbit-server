import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.js";
import inviteRoutes from "./routes/invite.js";
import userRoutes from "./routes/user.js";
import clientRoutes from "./routes/client.js";
import taskRoutes from "./routes/task.js";
import roleRoutes from "./routes/role.js";
import permissionRoutes from "./routes/permission.js";
import clientPortalRoutes from "./routes/client-portal.js";
import requirementRoutes from "./routes/requirement.js";

export function createApp() {
  const app = express();

  app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  }));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());

  // NoSQL injection sanitizer
  function sanitize(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) delete obj[key];
      else if (typeof obj[key] === "object") sanitize(obj[key]);
    }
    return obj;
  }
  app.use((req, _res, next) => {
    if (req.body) sanitize(req.body);
    if (req.params) sanitize(req.params);
    if (req.query) sanitize(req.query);
    next();
  });

  // CORS — permissive for testing, real config in index.js
  app.use(cors({ origin: true, credentials: true }));

  // Health
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });

  // Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/invites", inviteRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/clients", clientRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/roles", roleRoutes);
  app.use("/api/permissions", permissionRoutes);
  app.use("/api/requirements", requirementRoutes);
  app.use("/api/client-portal", clientPortalRoutes);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ message: "Route not found" });
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    if (err.name === "MulterError") {
      const msgs = {
        LIMIT_FILE_SIZE: "File size exceeds the allowed limit",
        LIMIT_FILE_COUNT: "Too many files uploaded",
        LIMIT_UNEXPECTED_FILE: "Unexpected file field",
      };
      return res.status(400).json({ message: msgs[err.code] || err.message });
    }
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid ID format" });
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors || {}).map((e) => e.message);
      return res.status(400).json({ message: messages.join(", ") || err.message });
    }
    if (err.code === 11000) return res.status(409).json({ message: "Duplicate entry" });
    if (err.message === "Not allowed by CORS") return res.status(403).json({ message: "Origin not allowed" });
    if (err.message?.includes("not allowed")) return res.status(400).json({ message: err.message });

    console.error("Unhandled error:", err);
    return res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
