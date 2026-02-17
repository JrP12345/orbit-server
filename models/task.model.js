import mongoose from "mongoose";

const STATUSES = ["TODO", "DOING", "READY_FOR_REVIEW", "SENT_TO_CLIENT", "REVISION", "DONE"];

const taskSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    status: { type: String, enum: STATUSES, default: "TODO" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    attachments: [
      {
        key: { type: String, required: true },
        name: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, required: true },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
        uploadedByName: { type: String, default: "" },
        context: { type: String, enum: ["reference", "deliverable"], default: "reference" },
        at: { type: Date, default: Date.now },
      },
    ],
    history: [
      {
        from: { type: String, enum: STATUSES, required: true },
        to: { type: String, enum: STATUSES, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, required: true },
        byName: { type: String, default: "" },
        note: { type: String, default: "" },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

taskSchema.index({ organizationId: 1, clientId: 1, status: 1 });
taskSchema.index({ organizationId: 1, assignedTo: 1 });
taskSchema.index({ organizationId: 1, createdBy: 1 });

export const Task = mongoose.model("Task", taskSchema);
export const VALID_TASK_STATUSES = STATUSES;
