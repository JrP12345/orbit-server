import { Plan } from "../models/plan.model.js";

const PLANS = [
  { name: "FREE", maxClients: 3 },
  { name: "STARTER", maxClients: 10 },
  { name: "GROWTH", maxClients: 50 },
  { name: "ENTERPRISE", maxClients: 500 },
];

export async function seedPlans() {
  const ops = PLANS.map((plan) => ({
    updateOne: {
      filter: { name: plan.name },
      update: { $set: { maxClients: plan.maxClients } },
      upsert: true,
    },
  }));
  await Plan.bulkWrite(ops);
  console.log(`Plans seeded (${PLANS.length} tiers)`);
}

export async function getDefaultPlan() {
  return Plan.findOne({ name: "FREE" });
}
