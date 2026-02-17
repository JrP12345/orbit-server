import { Permission } from "../models/permission.model.js";

const PERMISSIONS = [
  { key: "PAGE_DASHBOARD", label: "Dashboard", description: "View the workspace dashboard", group: "Page Access" },
  { key: "PAGE_TASKS", label: "Tasks Page", description: "Access the tasks section", group: "Page Access" },
  { key: "PAGE_CLIENTS", label: "Clients Page", description: "Access the clients section", group: "Page Access" },
  { key: "PAGE_SETTINGS", label: "Settings", description: "Access organization settings", group: "Page Access" },
  { key: "TASK_CREATE", label: "Create Tasks", description: "Create new tasks and assign to team members", group: "Tasks" },
  { key: "TASK_EDIT", label: "Edit Tasks", description: "Edit task details, title, description, and assignees", group: "Tasks" },
  { key: "TASK_DELETE", label: "Delete Tasks", description: "Permanently delete tasks", group: "Tasks" },
  { key: "TASK_VIEW_ALL", label: "View All Tasks", description: "See all tasks in the organization", group: "Tasks" },
  { key: "TASK_MOVE_OWN", label: "Move Own Tasks", description: "Move assigned tasks through the workflow", group: "Tasks" },
  { key: "TASK_REVIEW", label: "Review Tasks", description: "Request changes on submitted tasks", group: "Tasks" },
  { key: "TASK_SEND_TO_CLIENT", label: "Send to Client", description: "Send reviewed tasks to the client", group: "Tasks" },
  { key: "TASK_CLIENT_DECISION", label: "Client Decision", description: "Record client approval or rejection", group: "Tasks" },
  { key: "CLIENT_MANAGE", label: "Manage Clients", description: "Create, edit, and archive client accounts", group: "Clients" },
  { key: "USER_INVITE", label: "Invite Members", description: "Invite new members and manage existing team", group: "Team" },
  { key: "ROLE_MANAGE", label: "Manage Roles", description: "Create, edit, and assign roles and permissions", group: "Team" },
];

export async function seedPermissions() {
  const currentKeys = PERMISSIONS.map((p) => p.key);
  const ops = PERMISSIONS.map((perm) => ({
    updateOne: {
      filter: { key: perm.key },
      update: { $set: { label: perm.label, description: perm.description, group: perm.group } },
      upsert: true,
    },
  }));
  await Permission.bulkWrite(ops);

  const removed = await Permission.deleteMany({ key: { $nin: currentKeys } });
  if (removed.deletedCount > 0) console.log(`Removed ${removed.deletedCount} deprecated permissions`);
  console.log(`Permissions seeded (${PERMISSIONS.length} keys)`);
}

export async function getAllPermissionIds() {
  const perms = await Permission.find({}).select("_id").lean();
  return perms.map((p) => p._id);
}

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
