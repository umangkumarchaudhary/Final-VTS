const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const cors = require("cors");
require("dotenv").config();

const router = express.Router();
const app = express();

// Middleware
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// List of allowed roles
const allowedRoles = [
  "Admin",
  "Workshop Manager",
  "Security Guard",
  "Active Reception Technician",
  "Service Advisor",
  "Job Controller",
  "Bay Technician",
  "Final Inspection Technician",
  "Washing",
  "Parts Team",
];

// MongoDB User Schema - With Password
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    mobile: { type: String, unique: true, required: true },
    email: { type: String, sparse: true, default: null },
    password: { type: String, required: true }, // Plain-text password (for now)
    role: { type: String, enum: allowedRoles, required: true },
  },
  { timestamps: true }
);

const User = mongoose.models.User || mongoose.model("User", UserSchema);

const authMiddleware = async (req, res, next) => {
  const rawHeader = req.header("Authorization");
  console.log("📥 Raw Authorization Header:", rawHeader);

  const token = rawHeader?.replace("Bearer ", "");
  if (!token) {
    console.log("❌ No Token Provided");
    return res.status(401).json({ message: "Access Denied. No token provided." });
  }

  try {
    console.log("🔹 Extracted Token:", token);

    // Optional: check if it has the correct JWT structure
    if (!token.includes('.') || token.split('.').length !== 3) {
      console.log("⚠️ Token does not look like a valid JWT (missing parts)");
    }

    console.log("🔹 Verifying Token...");
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    console.log("✅ Token Verified:", verified);

    const user = await User.findById(verified.userId);
    if (!user) {
      console.log("❌ User Not Found in Database for ID:", verified.userId);
      return res.status(401).json({ message: "User not found." });
    }

    console.log("✅ Authenticated User:", {
      id: user._id,
      role: user.role,
      name: user.name
    });

    req.user = user;
    next();
  } catch (error) {
    console.error("❌ Token Verification Failed:", error.message);

    // Provide more detailed error response
    return res.status(400).json({ 
      message: "Invalid Token", 
      error: error.message 
    });
  }
};


// ✅ Register User (No approval required)
router.post("/register", async (req, res) => {
  try {
    const { name, mobile, email, password, role } = req.body;

    // Validate input
    if (!name || !mobile || !password || !allowedRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid input data." });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ mobile });
    if (existingUser) {
      return res.status(400).json({ message: "User with this mobile already registered" });
    }

    // Format email if provided
    const formattedEmail = email && email.trim() !== "" ? email.trim().toLowerCase() : null;

    if (formattedEmail) {
      const existingEmailUser = await User.findOne({ email: formattedEmail });
      if (existingEmailUser) {
        return res.status(400).json({ message: "User with this email already registered" });
      }
    }

    // Create user
    const newUser = new User({
      name,
      mobile,
      email: formattedEmail,
      password, // Store as plain-text for now (no hashing)
      role,
    });

    await newUser.save();

    res.status(201).json({
      success: true,
      message: "User registered successfully. You can log in immediately.",
    });
  } catch (error) {
    console.error("Registration Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message || error,
    });
  }
});

// ✅ Login (Mobile & Password Required)
router.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res.status(400).json({ message: "Mobile and password are required." });
    }

    // Find user by Mobile
    const user = await User.findOne({ mobile });

    if (!user || user.password !== password) {
      return res.status(404).json({ message: "Invalid mobile or password." });
    }

    // Generate JWT with long expiration
    const token = jwt.sign(
      { userId: user._id, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "365d" } // Users stay logged in for 1 year
    );

    res.json({
      success: true,
      token,
      user: {
        name: user.name,
        mobile: user.mobile,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error", error });
  }
});

// ✅ Logout API - No action needed
router.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

// ✅ Get All Users (Admin Access)
router.get("/users", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Access Denied. Admins only." });
    }

    const users = await User.find();

    // Exclude passwords from response
    const sanitizedUsers = users.map(user => ({
      _id: user._id,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt
    }));

    res.json({ success: true, users: sanitizedUsers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error", error });
  }
});

// ✅ Get User Profile
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = req.user; // Authenticated user from middleware

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({
      success: true,
      profile: {
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ success: false, message: "Server error", error });
  }
});

// ✅ Delete User (Admin Only)
router.delete("/users/:userId", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ message: "Access Denied. Admins only." });
    }

    const userId = req.params.userId;
    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server error", error });
  }
});

module.exports = { router, authMiddleware, User };
