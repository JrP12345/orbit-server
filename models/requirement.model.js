import mongoose from "mongoose";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const REQ_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED", "CLOSED"];

const requirementSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    priority: { type: String, enum: PRIORITIES, default: "MEDIUM" },
    status: { type: String, enum: REQ_STATUSES, default: "OPEN" },
    linkedTaskIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Task" }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    attachments: [
      {
        key: { type: String, required: true },
        name: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, required: true },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
        uploadedByName: { type: String, default: "" },
        uploadedByType: { type: String, enum: ["client", "user", "organization"], default: "client" },
        at: { type: Date, default: Date.now },
      },
    ],
    comments: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, required: true },
        byName: { type: String, default: "" },
        byType: { type: String, enum: ["client", "user", "organization"], required: true },
        message: { type: String, required: true, trim: true },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

requirementSchema.index({ organizationId: 1, clientId: 1, status: 1 });

export const Requirement = mongoose.model("Requirement", requirementSchema);
export const VALID_PRIORITIES = PRIORITIES;
export const VALID_REQ_STATUSES = REQ_STATUSES;
