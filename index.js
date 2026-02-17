import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import cookieParser from "cookie-parser";
import { connectDB, gracefulDisconnect } from "./db/connectDb.js";
import { connectRedis, disconnectRedis, getRedisClient } from "./db/redis.js";
import { seedPlans } from "./lib/plans.js";
import { seedPermissions } from "./lib/permissions.js";
import { ensureSystemRolesForAllOrgs } from "./lib/roles.js";
import authRoutes from "./routes/auth.js";
import inviteRoutes from "./routes/invite.js";
import userRoutes from "./routes/user.js";
import clientRoutes from "./routes/client.js";
import taskRoutes from "./routes/task.js";
import roleRoutes from "./routes/role.js";
import permissionRoutes from "./routes/permission.js";
import clientPortalRoutes from "./routes/client-portal.js";
import requirementRoutes from "./routes/requirement.js";

const app = express();

if (process.env.NODE_ENV !== "development") {
  app.set("trust proxy", 1);
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

// Redis-backed rate limit store (falls back to memory if Redis unavailable)
function buildStore() {
  const redis = getRedisClient();
  if (redis?.status === "ready") {
    return new RedisStore({ sendCommand: (...args) => redis.call(...args) });
  }
  return undefined; // falls back to default MemoryStore
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore(),
  message: { message: "Too many requests, please try again later" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore(),
  message: { message: "Too many attempts, please try again later" },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cookieParser());

// NoSQL injection sanitizer (Express 5 compatible)
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
  next();
});

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Auth rate limiters
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
app.use("/api/client-portal/accept-invite", authLimiter);
app.use("/api", apiLimiter);

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

const PORT = process.env.PORT || 5000;
let server;

async function startServer() {
  try {
    await connectDB();
    await connectRedis();
    await seedPlans();
    await seedPermissions();
    await ensureSystemRolesForAllOrgs();
    server = app.listen(PORT, () => console.log(`Orbit server running on port ${PORT}`));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  if (server) {
    server.close(async () => {
      await gracefulDisconnect();
      await disconnectRedis();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
process.on("uncaughtException", (error) => { console.error("Uncaught Exception:", error); process.exit(1); });

startServer();