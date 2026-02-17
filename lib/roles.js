import { Role } from "../models/role.model.js";
import { Permission } from "../models/permission.model.js";
import { getAllPermissionIds } from "./permissions.js";

export const DEFAULT_ROLE_TEMPLATES = [
  {
    name: "Manager",
    permissions: [
      "PAGE_DASHBOARD", "PAGE_TASKS", "PAGE_CLIENTS", "PAGE_SETTINGS",
      "TASK_CREATE", "TASK_EDIT", "TASK_DELETE", "TASK_VIEW_ALL", "TASK_MOVE_OWN",
      "TASK_REVIEW", "TASK_SEND_TO_CLIENT", "TASK_CLIENT_DECISION",
      "CLIENT_MANAGE", "USER_INVITE",
    ],
  },
  {
    name: "Editor",
    permissions: [
      "PAGE_DASHBOARD", "PAGE_TASKS", "PAGE_CLIENTS",
      "TASK_CREATE", "TASK_EDIT", "TASK_VIEW_ALL", "TASK_MOVE_OWN", "TASK_REVIEW",
      "CLIENT_MANAGE",
    ],
  },
  {
    name: "Social Media Manager",
    permissions: [
      "PAGE_DASHBOARD", "PAGE_TASKS", "PAGE_CLIENTS",
      "TASK_CREATE", "TASK_EDIT", "TASK_MOVE_OWN",
      "TASK_SEND_TO_CLIENT", "TASK_CLIENT_DECISION",
    ],
  },
  {
    name: "Graphic Designer",
    permissions: ["PAGE_DASHBOARD", "PAGE_TASKS", "TASK_MOVE_OWN"],
  },
  {
    name: "Secretary",
    permissions: [
      "PAGE_DASHBOARD", "PAGE_TASKS", "PAGE_CLIENTS", "PAGE_SETTINGS",
      "TASK_CREATE", "TASK_EDIT", "TASK_VIEW_ALL", "TASK_MOVE_OWN",
      "CLIENT_MANAGE", "USER_INVITE",
    ],
  },
];

const MEMBER_PERM_KEYS = ["PAGE_DASHBOARD", "PAGE_TASKS", "TASK_MOVE_OWN"];

async function resolvePermIds(keys) {
  const docs = await Permission.find({ key: { $in: keys } }).select("_id").lean();
  return docs.map((p) => p._id);
}

async function ensureTemplates(organizationId) {
  for (const tpl of DEFAULT_ROLE_TEMPLATES) {
    const exists = await Role.findOne({ organizationId, name: tpl.name });
    if (!exists) {
      const permIds = await resolvePermIds(tpl.permissions);
      await Role.create({ organizationId, name: tpl.name, permissions: permIds, isSystem: false });
    }
  }
}

export async function bootstrapOrgRoles(organizationId) {
  const allPermIds = await getAllPermissionIds();

  const ownerRole = await Role.findOneAndUpdate(
    { organizationId, name: "OWNER", isSystem: true },
    { $set: { permissions: allPermIds, isSystem: true } },
    { upsert: true, new: true }
  );

  const memberPermIds = await resolvePermIds(MEMBER_PERM_KEYS);
  const memberRole = await Role.findOneAndUpdate(
    { organizationId, name: "MEMBER", isSystem: true },
    { $set: { permissions: memberPermIds, isSystem: true } },
    { upsert: true, new: true }
  );

  await ensureTemplates(organizationId);
  return { ownerRole, memberRole };
}

export async function getDefaultMemberRole(organizationId) {
  return Role.findOne({ organizationId, name: "MEMBER", isSystem: true });
}

export async function getOwnerRole(organizationId) {
  return Role.findOne({ organizationId, name: "OWNER", isSystem: true });
}

export async function ensureSystemRolesForAllOrgs() {
  const { Organization } = await import("../models/organization.model.js");
  const orgs = await Organization.find({}).select("_id").lean();

  let created = 0;
  for (const org of orgs) {
    const existing = await Role.findOne({ organizationId: org._id, name: "OWNER", isSystem: true });
    if (!existing) {
      await bootstrapOrgRoles(org._id);
      created++;
    } else {
      // Sync OWNER permissions with any newly added permissions
      const allPermIds = await getAllPermissionIds();
      await Role.updateOne({ _id: existing._id }, { $set: { permissions: allPermIds } });

      // Sync MEMBER permissions
      const memberPermIds = await resolvePermIds(MEMBER_PERM_KEYS);
      await Role.updateOne(
        { organizationId: org._id, name: "MEMBER", isSystem: true },
        { $set: { permissions: memberPermIds } }
      );

      await ensureTemplates(org._id);
    }
  }

  if (created > 0) console.log(`System roles bootstrapped for ${created} organization(s)`);
  console.log("Default role templates ensured for all organizations");
}
