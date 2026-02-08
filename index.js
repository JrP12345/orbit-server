import express from "express";
import cors from "cors";
import { connectDB } from "./db/connectDb.js";
import authRoutes from "./routes/auth.js";
import inviteRoutes from "./routes/invite.js";
import userRoutes from "./routes/user.js";
import cookieParser from "cookie-parser";
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
}));
app.use("/api/auth", authRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/users", userRoutes);

const startServer = async ()=>{
    try {
      await connectDB();
      app.listen(process.env.PORT,()=>{
            console.log("Orbit Server is Running on:", process.env.PORT);
        })
    } catch (error) {
        console.error("❌ Failed to start server:", error);
        process.exit(1);
    }
}

startServer();