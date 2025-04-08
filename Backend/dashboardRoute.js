const express = require("express");
const router = express.Router();
const Vehicle = require("./models/vehicle");
const moment = require("moment");

// Utility function to get date range
const getDateRange = (filter) => {
  const now = moment();
  let startOfPeriod, endOfPeriod;

  switch (filter) {
    case "today":
      startOfPeriod = now.startOf("day");
      endOfPeriod = now.endOf("day");
      break;
    case "thisWeek":
      startOfPeriod = now.startOf("week");
      endOfPeriod = now.endOf("week");
      break;
    case "lastWeek":
      startOfPeriod = now.subtract(1, "week").startOf("week");
      endOfPeriod = now.subtract(1, "week").endOf("week");
      break;
    case "thisMonth":
      startOfPeriod = now.startOf("month");
      endOfPeriod = now.endOf("month");
      break;
    case "lastMonth":
      startOfPeriod = now.subtract(1, "month").startOf("month");
      endOfPeriod = now.subtract(1, "month").endOf("month");
      break;
    default:
      startOfPeriod = now.startOf("month");
      endOfPeriod = now.endOf("month");
  }
  
  return { startOfPeriod, endOfPeriod };
};

// ✅ GET: Fetch Stage-wise Vehicle Count
router.get("/vehicle-stage-summary", async (req, res) => {
  try {
    // Fetch all vehicles
    const vehicles = await Vehicle.find();

    if (vehicles.length === 0) {
      return res.status(404).json({ success: false, message: "No vehicles found." });
    }

    const stageSummary = {};

    // Iterate through vehicles and count each stage occurrence
    vehicles.forEach(vehicle => {
      vehicle.stages.forEach(stage => {
        if (!stageSummary[stage.stageName]) {
          stageSummary[stage.stageName] = { total: 0, completed: 0, active: 0 };
        }
        
        stageSummary[stage.stageName].total += 1;
        
        if (stage.eventType === "Start") {
          stageSummary[stage.stageName].active += 1;
        } else if (stage.eventType === "End") {
          stageSummary[stage.stageName].completed += 1;
        }
      });
    });

    return res.status(200).json({ success: true, data: stageSummary });

  } catch (error) {
    console.error("❌ Error in GET /vehicle-stage-summary:", error);
    res.status(500).json({ success: false, message: "Server error", error });
  }
});


router.get("/vehiclesDetails", async (req, res) => {
  try {
    const allVehicles = await Vehicle.find().sort({ entryTime: -1 });
    const completedVehiclesList = allVehicles.filter(v => v.exitTime !== null);

    return res.status(200).json({
      success: true,
      data: {
        totalVehicles: allVehicles.length,
        completedVehicles: completedVehiclesList.length,
        allVehicles,
        completedVehiclesList
      }
    });
  } catch (error) {
    console.error("❌ Error in GET /vehicles:", error);
    res.status(500).json({ success: false, message: "Server error", error });
  }
});


// Dashboard - Vehicle Count per Stage (with Date Filter)
router.get("/dashboard/vehicle-count", async (req, res) => {
  const { stageName, dateFilter } = req.query;
  
  try {
    const { startOfPeriod, endOfPeriod } = getDateRange(dateFilter);

    const vehicles = await Vehicle.find({
      "stages.stageName": stageName,
      "stages.timestamp": { $gte: startOfPeriod.toDate(), $lte: endOfPeriod.toDate() },
    });

    let totalVehicles = 0;
    let completedVehicles = 0;

    vehicles.forEach(vehicle => {
      const stage = vehicle.stages.find(s => s.stageName === stageName);
      if (stage) {
        totalVehicles++;

        // Check if stage is "completed"
        if (stage.startTime && stage.endTime) {
          completedVehicles++;
        } else if (
          ["Job Card Creation + Customer Approval", "Job Card Received + Bay Allocation"].includes(stageName) &&
          stage.startTime
        ) {
          completedVehicles++; // Consider these stages completed even if only start exists
        }
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        stageName,
        totalVehicles,
        completedVehicles
      }
    });

  } catch (error) {
    console.error("Error in /dashboard/vehicle-count:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



// 2️⃣ Dashboard - Vehicle Average Time per Stage (with Date Filter)
router.get("/dashboard/average-time", async (req, res) => {
  const { stageName, dateFilter } = req.query; // e.g., "Interactive Bay", "today", "thisWeek"
  
  try {
    const { startOfPeriod, endOfPeriod } = getDateRange(dateFilter);

    const vehicles = await Vehicle.aggregate([
      {
        $match: {
          "stages.stageName": stageName,
          "stages.timestamp": { $gte: startOfPeriod.toDate(), $lte: endOfPeriod.toDate() },
        }
      },
      { $unwind: "$stages" },
      {
        $match: {
          "stages.stageName": stageName,
        }
      },
      {
        $project: {
          vehicleNumber: 1,
          stages: 1,
          _id: 0
        }
      },
      {
        $unwind: "$stages"
      },
      {
        $match: {
          "stages.stageName": stageName,
        }
      },
      {
        $group: {
          _id: "$vehicleNumber",
          totalTime: { $sum: { $subtract: [ "$stages.timestamp", { $ifNull: [ "$stages.timestamp", 0 ] } ] } },
          vehicleCount: { $sum: 1 }
        }
      },
      {
        $project: {
          vehicleNumber: "$_id",
          averageTime: { $divide: ["$totalTime", "$vehicleCount"] }
        }
      }
    ]);

    if (!vehicles.length) {
      return res.status(404).json({ success: false, message: "No vehicle data found." });
    }

    return res.status(200).json({ success: true, data: vehicles });
  } catch (error) {
    console.error("Error in /dashboard/average-time:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// 3️⃣ Dashboard - Vehicle Report for Specific Vehicle Number (Detailed Report per Stage)
router.get("/dashboard/vehicle-report/:vehicleNumber", async (req, res) => {
  const { vehicleNumber } = req.params;
  
  try {
    const vehicle = await Vehicle.findOne({ vehicleNumber: vehicleNumber.trim().toUpperCase() });

    if (!vehicle) {
      return res.status(404).json({ success: false, message: "Vehicle not found." });
    }

    return res.status(200).json({ success: true, vehicle });
  } catch (error) {
    console.error("Error in /dashboard/vehicle-report:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// 4️⃣ Dashboard - All Vehicles Report (with Stage Data)
router.get("/dashboard/all-vehicles", async (req, res) => {
  const { dateFilter } = req.query;
  
  try {
    const { startOfPeriod, endOfPeriod } = getDateRange(dateFilter);

    const vehicles = await Vehicle.aggregate([
      {
        $match: {
          "stages.timestamp": { $gte: startOfPeriod.toDate(), $lte: endOfPeriod.toDate() },
        }
      },
      { $unwind: "$stages" },
      {
        $group: {
          _id: "$vehicleNumber",
          stages: { $push: "$stages" },
          totalStages: { $sum: 1 }
        }
      }
    ]);

    if (!vehicles.length) {
      return res.status(404).json({ success: false, message: "No vehicles found." });
    }

    return res.status(200).json({ success: true, data: vehicles });
  } catch (error) {
    console.error("Error in /dashboard/all-vehicles:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
