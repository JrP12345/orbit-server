import { Client } from "../models/client.model.js";
import { Organization } from "../models/organization.model.js";
import { Plan } from "../models/plan.model.js";
import { getDefaultPlan } from "../lib/plans.js";

export async function checkClientLimit(organizationId) {
  const org = await Organization.findById(organizationId);
  if (!org) return { allowed: false, message: "Organization not found" };

  if (!org.planId) {
    const defaultPlan = await getDefaultPlan();
    if (!defaultPlan) return { allowed: false, message: "No plans configured. Contact support." };
    org.planId = defaultPlan._id;
    await org.save();
  }

  const plan = await Plan.findById(org.planId);
  if (!plan) return { allowed: false, message: "Organization plan not found. Contact support." };

  const activeCount = await Client.countDocuments({
    organizationId,
    status: { $in: ["ACTIVE", "INVITED"] },
  });

  if (activeCount >= plan.maxClients) {
    return {
      allowed: false,
      message: `You've reached the maximum of ${plan.maxClients} active clients on the ${plan.name} plan. Upgrade your plan or archive existing clients to add more.`,
      activeCount,
      maxClients: plan.maxClients,
      planName: plan.name,
    };
  }

  return { allowed: true, activeCount, maxClients: plan.maxClients, planName: plan.name };
}
