/**
 * Global test setup — spins up MongoMemoryServer once,
 * seeds plans & permissions, and tears down after all suites finish.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { seedPlans } from "../lib/plans.js";
import { seedPermissions } from "../lib/permissions.js";

let mongoServer;

beforeAll(async () => {
  // Suppress console.log noise from seeds
  const origLog = console.log;
  console.log = () => {};

  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  process.env.MONGO_URI = uri;
  process.env.NODE_ENV = "development"; // allow registration endpoint

  await mongoose.connect(uri);
  await seedPlans();
  await seedPermissions();

  console.log = origLog;
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
