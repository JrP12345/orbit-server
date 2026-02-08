import express from "express";
import cors from "cors";
import { connectDB } from "./db/connectDb.js";
import authRoutes from "./routes/auth.js";
import cookieParser from "cookie-parser";
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));
app.use("/api/auth", authRoutes);

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