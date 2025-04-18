const express = require("express");
const router = express.Router();
const Vehicle = require("./models/vehicle");
const moment = require("moment-timezone");
const {authMiddleware} = require("./userAuth");


const toIST = (date) => moment(date).tz("Asia/Kolkata");

const calculateDuration = (start, end = new Date()) => {
  const duration = moment.duration(moment(end).diff(moment(start)));
  return {
    days: duration.days(),
    hours: duration.hours(),
    minutes: duration.minutes(),
    formatted: `${duration.days()}d ${duration.hours()}h ${duration.minutes()}m`
  };
};

const dateRange = (type) => {
  const now = moment().tz("Asia/Kolkata");
  switch (type) {
    case "today":
      return [now.clone().startOf("day").toDate(), now.toDate()];
    case "yesterday":
      return [
        now.clone().subtract(1, "day").startOf("day").toDate(),
        now.clone().subtract(1, "day").endOf("day").toDate()
      ];
    case "thisWeek":
      return [now.clone().startOf("week").toDate(), now.toDate()];
    case "lastWeek":
      return [
        now.clone().subtract(1, "week").startOf("week").toDate(),
        now.clone().subtract(1, "week").endOf("week").toDate()
      ];
    case "last7Days":
      return [now.clone().subtract(7, "days").toDate(), now.toDate()];
    case "last30Days":
      return [now.clone().subtract(30, "days").toDate(), now.toDate()];
    case "thisMonth":
      return [now.clone().startOf("month").toDate(), now.toDate()];
    case "lastMonth":
      return [
        now.clone().subtract(1, "month").startOf("month").toDate(),
        now.clone().subtract(1, "month").endOf("month").toDate()
      ];
    default:
      return [];
  }
};

router.get("/vehicle-summary", async (req, res) => {
  try {
    const sort = req.query.sort === "oldest" ? 1 : -1;
    const now = moment().tz("Asia/Kolkata").toDate();

    // Get vehicles still inside premises
    const vehiclesInside = await Vehicle.find({ exitTime: null }).sort({ entryTime: sort });

    // Attach duration and last scanned stage to each vehicle
    const insideWithDurations = vehiclesInside.map((v) => {
      const entryIST = toIST(v.entryTime);
      const duration = calculateDuration(entryIST, now);

      // Get last relevant stage from embedded stages array
      const lastStageEntry = v.stages
        .filter(s => s.eventType === "Start" || s.eventType === "Resume")
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      const lastStage = lastStageEntry?.stageName || "Not yet scanned";
      const lastStageScannedAt = lastStageEntry
        ? toIST(lastStageEntry.timestamp).format("DD-MM-YYYY hh:mm A")
        : null;

      return {
        ...v.toObject(),
        entryIST: entryIST.format("DD-MM-YYYY hh:mm A"),
        liveDuration: duration.formatted,
        lastStage,
        lastStageScannedAt
      };
    });

    // Helper function to count by date range
    const countByDate = async (type, isExited = false) => {
      const [start, end] = dateRange(type);
      const query = isExited
        ? { exitTime: { $gte: start, $lte: end } }
        : { entryTime: { $gte: start, $lte: end } };
      return Vehicle.countDocuments(query);
    };

    // Stats
    const stats = {
      enteredToday: await countByDate("today"),
      enteredThisWeek: await countByDate("thisWeek"),
      enteredThisMonth: await countByDate("thisMonth"),
      exitedToday: await countByDate("today", true),
      exitedThisWeek: await countByDate("thisWeek", true),
      exitedThisMonth: await countByDate("thisMonth", true)
    };

    // Avg time spent
    const exitedVehicles = await Vehicle.find({ exitTime: { $ne: null } });
    const avgTimeMs =
      exitedVehicles.reduce((sum, v) => sum + (v.exitTime - v.entryTime), 0) /
      (exitedVehicles.length || 1);
    const avgDuration = calculateDuration(0, avgTimeMs);

    // Longest active vehicle
    const longestActive = await Vehicle.findOne({ exitTime: null }).sort({ entryTime: 1 });

    res.json({
      vehiclesInside: insideWithDurations,
      stats,
      avgTimeSpent: avgDuration.formatted,
      longestActive: longestActive
        ? {
            vehicle: longestActive,
            since: toIST(longestActive.entryTime).format("DD-MM-YYYY hh:mm A"),
            duration: calculateDuration(longestActive.entryTime, now).formatted
          }
        : null
    });
  } catch (err) {
    console.error("Error in vehicle-summary route:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.get("/dashboard/stage-averages", authMiddleware, async (req, res) => {
  try {
    const restrictedStages = [
      "Interactive Bay", 
      "Washing", 
      "Final Inspection", 
      "Creation of Parts Estimate"
    ];

    const formatDuration = (minutes) => {
      const totalSeconds = Math.floor(minutes * 60);
      const hours = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      const secs = totalSeconds % 60;
      return [hours, mins, secs].map(n => n.toString().padStart(2, '0')).join(':');
    };

    const formatMilliseconds = (ms) => formatDuration(ms / 60000);

    const getDateRanges = () => {
      const now = new Date();
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        today: { start: startOfDay, end: new Date() },
        thisWeek: { start: startOfWeek, end: new Date() },
        thisMonth: { start: startOfMonth, end: new Date() },
        lastMonth: { start: startOfLastMonth, end: endOfLastMonth }
      };
    };

    const dateRanges = getDateRanges();
    const timePeriods = Object.keys(dateRanges);

    const result = {};
    timePeriods.forEach(period => {
      result[period] = {};
      restrictedStages.forEach(stage => {
        result[period][stage] = {
          totalDurationMs: 0,
          count: 0,
          details: []
        };
      });
    });

    for (const period of timePeriods) {
      const { start, end } = dateRanges[period];

      const vehicles = await Vehicle.find({
        "stages.timestamp": { $gte: start, $lte: end },
        "stages.stageName": { $in: restrictedStages }
      });

      for (const vehicle of vehicles) {
        restrictedStages.forEach(stageName => {
          const stageEvents = vehicle.stages
            .filter(s => s.stageName === stageName && s.timestamp >= start && s.timestamp <= end)
            .sort((a, b) => a.timestamp - b.timestamp);

          const starts = stageEvents.filter(e => e.eventType === "Start");
          const ends = stageEvents.filter(e => e.eventType === "End");

          starts.forEach(startEvent => {
            const endEvent = ends.find(e => e.timestamp > startEvent.timestamp);
            if (endEvent) {
              const durationMs = endEvent.timestamp - startEvent.timestamp;
              result[period][stageName].totalDurationMs += durationMs;
              result[period][stageName].count++;

              result[period][stageName].details.push({
                vehicleNumber: vehicle.vehicleNumber,
                startTime: startEvent.timestamp,
                endTime: endEvent.timestamp,
                duration: formatMilliseconds(durationMs)
              });
            }
          });
        });
      }
    }

    // Format result with durations and averages
    const formattedResult = {};
    timePeriods.forEach(period => {
      formattedResult[period] = {};
      restrictedStages.forEach(stageName => {
        const stageData = result[period][stageName];
        const avg = stageData.count > 0
          ? formatMilliseconds(stageData.totalDurationMs / stageData.count)
          : "00:00:00";

        formattedResult[period][stageName] = {
          totalDuration: formatMilliseconds(stageData.totalDurationMs),
          count: stageData.count,
          average: avg,
          details: stageData.details
        };
      });
    });

    return res.status(200).json({
      success: true,
      message: "Stage averages calculated successfully",
      data: formattedResult
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/stage-averages:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});


router.get("/dashboard/special-stage-averages", authMiddleware, async (req, res) => {
  try {
    const specialStages = [
      "Job Card Creation + Customer Approval",
      "Additional Work Job Approval",
      "Ready for Washing"
    ];

    const formatDuration = (milliseconds) => {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const remainingSeconds = totalSeconds % 3600;
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;

      return [
        hours.toString().padStart(2, '0'),
        mins.toString().padStart(2, '0'),
        secs.toString().padStart(2, '0')
      ].join(':');
    };

    const getDateRanges = () => {
      const now = new Date();
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

      return {
        today: { start: startOfDay, end: new Date() },
        thisWeek: { start: startOfWeek, end: new Date() },
        thisMonth: { start: startOfMonth, end: new Date() },
        lastMonth: { start: startOfLastMonth, end: endOfLastMonth }
      };
    };

    const dateRanges = getDateRanges();
    const timePeriods = Object.keys(dateRanges);

    const result = {};
    timePeriods.forEach(period => {
      result[period] = {};
      specialStages.forEach(stage => {
        result[period][stage] = {
          totalDurationMs: 0,
          totalDurationFormatted: "00:00:00",
          count: 0,
          averageMs: 0,
          averageFormatted: "00:00:00",
          details: []  // 👈 Add transparency log
        };
      });
    });

    for (const period of timePeriods) {
      const { start, end } = dateRanges[period];

      const vehicles = await Vehicle.find({
        "stages.timestamp": { $gte: start, $lte: end },
        "stages.stageName": {
          $in: [
            ...specialStages,
            "Job Card Received + Bay Allocation",
            "Bay Work",
            "Washing"
          ]
        }
      });

      vehicles.forEach(vehicle => {
        const vehicleStages = vehicle.stages
          .filter(s => s.timestamp >= start && s.timestamp <= end)
          .sort((a, b) => a.timestamp - b.timestamp);

        const vehicleNumber = vehicle.vehicleNumber;

        // Job Card Creation + Customer Approval
        const jobCardStarts = vehicleStages.filter(
          s => s.stageName === "Job Card Creation + Customer Approval" && s.eventType === "Start"
        );

        jobCardStarts.forEach(startEvent => {
          const endEvent = vehicleStages.find(s =>
            s.stageName.startsWith("Job Card Received + Bay Allocation") &&
            s.eventType === "Start" &&
            s.timestamp > startEvent.timestamp
          );

          if (endEvent) {
            const duration = endEvent.timestamp - startEvent.timestamp;
            result[period]["Job Card Creation + Customer Approval"].totalDurationMs += duration;
            result[period]["Job Card Creation + Customer Approval"].count++;
            result[period]["Job Card Creation + Customer Approval"].details.push({
              vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: endEvent.timestamp,
              duration: formatDuration(duration)
            });
          }
        });

        // Additional Work Job Approval
        const additionalApprovalStarts = vehicleStages.filter(
          s => s.stageName.startsWith("Additional Work Job Approval") && s.eventType === "Start"
        );

        additionalApprovalStarts.forEach(startEvent => {
          const subsequentBayAllocations = vehicleStages.filter(s =>
            s.stageName.startsWith("Job Card Received + Bay Allocation") &&
            s.eventType === "Start" &&
            s.timestamp > startEvent.timestamp
          );

          if (subsequentBayAllocations.length >= 2) {
            const endEvent = subsequentBayAllocations[1];
            const duration = endEvent.timestamp - startEvent.timestamp;
            result[period]["Additional Work Job Approval"].totalDurationMs += duration;
            result[period]["Additional Work Job Approval"].count++;
            result[period]["Additional Work Job Approval"].details.push({
              vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: endEvent.timestamp,
              duration: formatDuration(duration)
            });
          }
        });

        // Ready for Washing
        const washingReadyStarts = vehicleStages.filter(
          s => s.stageName === "Ready for Washing" && s.eventType === "Start"
        );

        washingReadyStarts.forEach(startEvent => {
          const endEvent = vehicleStages.find(s =>
            s.stageName === "Washing" &&
            s.eventType === "Start" &&
            s.timestamp > startEvent.timestamp
          );

          if (endEvent) {
            const duration = endEvent.timestamp - startEvent.timestamp;
            result[period]["Ready for Washing"].totalDurationMs += duration;
            result[period]["Ready for Washing"].count++;
            result[period]["Ready for Washing"].details.push({
              vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: endEvent.timestamp,
              duration: formatDuration(duration)
            });
          }
        });
      });

      // Calculate average durations
      specialStages.forEach(stageName => {
        const stageData = result[period][stageName];
        if (stageData.count > 0) {
          stageData.averageMs = stageData.totalDurationMs / stageData.count;
          stageData.totalDurationFormatted = formatDuration(stageData.totalDurationMs);
          stageData.averageFormatted = formatDuration(stageData.averageMs);
        }
      });
    }

    // Final response
    const formattedResult = {};
    timePeriods.forEach(period => {
      formattedResult[period] = {};
      specialStages.forEach(stageName => {
        const stageData = result[period][stageName];
        formattedResult[period][stageName] = {
          totalDuration: stageData.totalDurationFormatted,
          count: stageData.count,
          average: stageData.averageFormatted,
          details: stageData.details
        };
      });
    });

    return res.status(200).json({
      success: true,
      message: "Special stage averages calculated successfully",
      data: formattedResult
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/special-stage-averages:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});


router.get("/dashboard/job-card-received-metrics", authMiddleware, async (req, res) => {
  try {
    const formatDuration = (milliseconds) => {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const remainingSeconds = totalSeconds % 3600;
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;

      return [
        hours.toString().padStart(2, '0'),
        mins.toString().padStart(2, '0'),
        secs.toString().padStart(2, '0')
      ].join(':');
    };

    const getDateRanges = () => {
      const now = new Date();
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

      return {
        today: { start: startOfDay, end: new Date() },
        thisWeek: { start: startOfWeek, end: new Date() },
        thisMonth: { start: startOfMonth, end: new Date() },
        lastMonth: { start: startOfLastMonth, end: endOfLastMonth }
      };
    };

    const dateRanges = getDateRanges();
    const timePeriods = Object.keys(dateRanges);

    const result = {};
    timePeriods.forEach(period => {
      result[period] = {
        jobCardReceivedBayAllocation: {
          totalDuration: "00:00:00",
          count: 0,
          average: "00:00:00",
          details: []
        },
        jobCardReceivedByTechnician: {
          totalDuration: "00:00:00",
          count: 0,
          average: "00:00:00",
          details: []
        },
        jobCardReceivedByFI: {
          totalDuration: "00:00:00",
          count: 0,
          average: "00:00:00",
          details: []
        }
      };
    });

    for (const period of timePeriods) {
      const { start, end } = dateRanges[period];
      const vehicles = await Vehicle.find({
        "stages.timestamp": { $gte: start, $lte: end }
      });

      for (const vehicle of vehicles) {
        const vehicleStages = vehicle.stages.filter(
          s => s.timestamp >= start && s.timestamp <= end
        );

        // Job Card Received + Bay Allocation
        const jcReceivedStarts = vehicleStages.filter(
          s => s.stageName.startsWith("Job Card Received + Bay Allocation") &&
               s.eventType === "Start"
        );

        for (const startEvent of jcReceivedStarts) {
          const nextBayWork = vehicleStages.find(s =>
            s.stageName.startsWith("Bay Work") &&
            s.eventType === "Start" &&
            s.timestamp > startEvent.timestamp
          );

          if (nextBayWork) {
            const duration = nextBayWork.timestamp - startEvent.timestamp;
            result[period].jobCardReceivedBayAllocation.details.push({
              vehicleNumber: vehicle.vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: nextBayWork.timestamp,
              duration: formatDuration(duration)
            });
          }
        }

        // Job Card Received (by Technician)
        const technicianStarts = vehicleStages.filter(
          s => s.stageName === "Job Card Received (by Technician)" &&
               s.eventType === "Start"
        );

        for (const technicianEvent of technicianStarts) {
          const previousStage = vehicleStages.find(s =>
            s.stageName.startsWith("Job Card Received + Bay Allocation") &&
            s.eventType === "Start" &&
            s.timestamp < technicianEvent.timestamp
          );

          if (previousStage) {
            const duration = technicianEvent.timestamp - previousStage.timestamp;
            result[period].jobCardReceivedByTechnician.details.push({
              vehicleNumber: vehicle.vehicleNumber,
              startTime: previousStage.timestamp,
              endTime: technicianEvent.timestamp,
              duration: formatDuration(duration)
            });
          }
        }

        // Job Card Received (by FI)
        const fiStarts = vehicleStages.filter(
          s => s.stageName === "Job Card Received (by FI)" &&
               s.eventType === "Start"
        );

        for (const fiEvent of fiStarts) {
          const previousTechnicianStage = vehicleStages.find(s =>
            s.stageName === "Job Card Received (by Technician)" &&
            s.eventType === "Start" &&
            s.timestamp < fiEvent.timestamp
          );

          if (previousTechnicianStage) {
            const duration = fiEvent.timestamp - previousTechnicianStage.timestamp;
            result[period].jobCardReceivedByFI.details.push({
              vehicleNumber: vehicle.vehicleNumber,
              startTime: previousTechnicianStage.timestamp,
              endTime: fiEvent.timestamp,
              duration: formatDuration(duration)
            });
          }
        }
      }

      // Final formatting: count, total, average
      Object.keys(result[period]).forEach(stage => {
        const items = result[period][stage].details;
        const count = items.length;
        if (count > 0) {
          const totalMs = items.reduce((sum, d) => {
            const [h, m, s] = d.duration.split(':').map(Number);
            return sum + ((h * 3600 + m * 60 + s) * 1000);
          }, 0);

          const avgMs = totalMs / count;
          result[period][stage].count = count;
          result[period][stage].totalDuration = formatDuration(totalMs);
          result[period][stage].average = formatDuration(avgMs);
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: "Simplified metrics for Job Card Received stages.",
      data: result
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/job-card-received-metrics:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});


router.get("/dashboard/bay-work-metrics", authMiddleware, async (req, res) => {
  try {
    const formatDuration = (milliseconds) => {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      const secs = totalSeconds % 60;
      return [hours, mins, secs].map(n => n.toString().padStart(2, '0')).join(':');
    };

    const getDateRanges = () => {
      const now = new Date();
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        today: { start: startOfDay, end: new Date() },
        thisWeek: { start: startOfWeek, end: new Date() },
        thisMonth: { start: startOfMonth, end: new Date() },
        lastMonth: { start: startOfLastMonth, end: endOfLastMonth }
      };
    };

    const dateRanges = getDateRanges();
    const timePeriods = Object.keys(dateRanges);

    const result = {};
    timePeriods.forEach(period => {
      result[period] = {
        byWorkType: {},
        overall: {
          totalDurationMs: 0,
          totalPausedDurationMs: 0,
          totalActiveDurationMs: 0,
          count: 0,
          details: []
        }
      };
    });

    for (const period of timePeriods) {
      const { start, end } = dateRanges[period];

      const vehicles = await Vehicle.find({
        "stages.timestamp": { $gte: start, $lte: end },
        "stages.stageName": { $regex: /^Bay Work:/ }
      });

      for (const vehicle of vehicles) {
        const bayWorkStages = vehicle.stages
          .filter(s => s.stageName.startsWith("Bay Work:") && s.timestamp >= start && s.timestamp <= end)
          .sort((a, b) => a.timestamp - b.timestamp);

        const workGroups = {};
        bayWorkStages.forEach(stage => {
          const { workType, bayNumber } = stage;
          if (!workType || !bayNumber) return;
          const key = `${workType}-${bayNumber}`;
          if (!workGroups[key]) {
            workGroups[key] = { workType, bayNumber, stages: [] };
          }
          workGroups[key].stages.push(stage);
        });

        for (const [_, group] of Object.entries(workGroups)) {
          const { workType, stages } = group;

          if (!result[period].byWorkType[workType]) {
            result[period].byWorkType[workType] = {
              totalDurationMs: 0,
              totalPausedDurationMs: 0,
              totalActiveDurationMs: 0,
              count: 0,
              details: []
            };
          }

          const starts = stages.filter(s => s.eventType === "Start");
          starts.forEach(startEvent => {
            const subsequent = stages.filter(s =>
              s.timestamp > startEvent.timestamp &&
              ["Pause", "Resume", "End"].includes(s.eventType)
            ).sort((a, b) => a.timestamp - b.timestamp);

            let endEvent = null;
            let lastTime = startEvent.timestamp;
            let paused = 0;
            let active = 0;
            let state = "active";

            for (const e of subsequent) {
              const duration = e.timestamp - lastTime;
              if (state === "active") active += duration;
              else paused += duration;

              if (e.eventType === "Pause") state = "paused";
              else if (e.eventType === "Resume") state = "active";
              else if (e.eventType === "End") {
                endEvent = e;
                break;
              }

              lastTime = e.timestamp;
            }

            if (endEvent) {
              const total = endEvent.timestamp - startEvent.timestamp;

              const detail = {
                vehicleNumber: vehicle.vehicleNumber,
                startTime: startEvent.timestamp,
                endTime: endEvent.timestamp,
                duration: formatDuration(total)
              };

              // Update per work type
              result[period].byWorkType[workType].totalDurationMs += total;
              result[period].byWorkType[workType].totalPausedDurationMs += paused;
              result[period].byWorkType[workType].totalActiveDurationMs += active;
              result[period].byWorkType[workType].count++;
              result[period].byWorkType[workType].details.push(detail);

              // Update overall
              result[period].overall.totalDurationMs += total;
              result[period].overall.totalPausedDurationMs += paused;
              result[period].overall.totalActiveDurationMs += active;
              result[period].overall.count++;
              result[period].overall.details.push(detail);
            }
          });
        }
      }
    }

    // Format final output
    const formattedResult = {};
    timePeriods.forEach(period => {
      const overall = result[period].overall;
      formattedResult[period] = {
        byWorkType: {},
        overall: {
          totalDuration: formatDuration(overall.totalDurationMs),
          activeDuration: formatDuration(overall.totalActiveDurationMs),
          pausedDuration: formatDuration(overall.totalPausedDurationMs),
          count: overall.count,
          average: overall.count > 0 ? formatDuration(overall.totalActiveDurationMs / overall.count) : "00:00:00",
          details: overall.details
        }
      };

      for (const [workType, data] of Object.entries(result[period].byWorkType)) {
        formattedResult[period].byWorkType[workType] = {
          totalDuration: formatDuration(data.totalDurationMs),
          activeDuration: formatDuration(data.totalActiveDurationMs),
          pausedDuration: formatDuration(data.totalPausedDurationMs),
          count: data.count,
          average: data.count > 0 ? formatDuration(data.totalActiveDurationMs / data.count) : "00:00:00",
          details: data.details
        };
      }
    });

    return res.status(200).json({
      success: true,
      message: "Bay Work metrics calculated successfully",
      data: formattedResult
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/bay-work-metrics:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});


router.get('/dashboard/live-status', authMiddleware, async (req, res) => {
  try {
    // Helper functions for formatting
    const formatToIST = (date) => {
      return date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$2-$1');
    };

    const formatDuration = (ms) => {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      
      return [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
      ].join(':');
    };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 1. Get all active vehicles (all time)
    const allTimeActiveVehicles = await Vehicle.find({ exitTime: null });

    // 2. Get today's vehicles (regardless of active status)
    const todaysVehicles = await Vehicle.find({
      entryTime: { $gte: startOfToday }
    }).sort({ entryTime: -1 });

    // Process stage data for all active vehicles
    const stageMap = {};
    const vehicleStageInfo = {};

    for (const vehicle of allTimeActiveVehicles) {
      const { vehicleNumber, stages } = vehicle;
      vehicleStageInfo[vehicleNumber] = {};

      const stageGroups = {};
      for (const stage of stages) {
        if (!stageGroups[stage.stageName]) {
          stageGroups[stage.stageName] = [];
        }
        stageGroups[stage.stageName].push(stage);
      }

      // Process each stage group to find active stages
      for (const [stageName, entries] of Object.entries(stageGroups)) {
        const starts = entries
          .filter(s => s.eventType === 'Start')
          .sort((a, b) => a.timestamp - b.timestamp);
        const ends = entries
          .filter(s => s.eventType === 'End')
          .sort((a, b) => a.timestamp - b.timestamp);

        for (const start of starts) {
          const isEnded = ends.some(end => end.timestamp > start.timestamp);
          if (!isEnded) {
            if (!stageMap[stageName]) {
              stageMap[stageName] = [];
            }

            const durationMs = now - start.timestamp;
            stageMap[stageName].push({
              vehicleNumber,
              startedAt: formatToIST(start.timestamp),
              performedBy: start.performedBy?.userName || 'Unknown',
              duration: formatDuration(durationMs),
              durationMinutes: Math.round(durationMs / 60000)
            });

            // Store last active stage for this vehicle
            if (!vehicleStageInfo[vehicleNumber].lastStage || 
                start.timestamp > vehicleStageInfo[vehicleNumber].lastStage.timestamp) {
              vehicleStageInfo[vehicleNumber].lastStage = {
                stageName,
                timestamp: formatToIST(start.timestamp),
                performedBy: start.performedBy?.userName || 'Unknown',
                duration: formatDuration(now - start.timestamp)
              };
            }
            break;
          }
        }
      }
    }

    // Format response
    const response = {
      allTimeActive: {
        count: allTimeActiveVehicles.length,
        vehicles: allTimeActiveVehicles.map(v => ({
          vehicleNumber: v.vehicleNumber,
          entryTime: formatToIST(v.entryTime),
          lastStage: vehicleStageInfo[v.vehicleNumber]?.lastStage || null,
          duration: formatDuration(now - v.entryTime),
          durationMinutes: Math.round((now - v.entryTime) / 60000)
        }))
      },
      todaysVehicles: {
        count: todaysVehicles.length,
        activeCount: todaysVehicles.filter(v => !v.exitTime).length,
        completedCount: todaysVehicles.filter(v => v.exitTime).length,
        vehicles: todaysVehicles.map(v => ({
          vehicleNumber: v.vehicleNumber,
          entryTime: formatToIST(v.entryTime),
          exitTime: v.exitTime ? formatToIST(v.exitTime) : null,
          isActive: !v.exitTime,
          lastStage: vehicleStageInfo[v.vehicleNumber]?.lastStage || null,
          duration: v.exitTime 
            ? formatDuration(v.exitTime - v.entryTime)
            : formatDuration(now - v.entryTime),
          durationMinutes: v.exitTime 
            ? Math.round((v.exitTime - v.entryTime) / 60000)
            : Math.round((now - v.entryTime) / 60000)
        }))
      },
      stageWiseDistribution: stageMap,
      updatedAt: formatToIST(now)
    };

    res.status(200).json({
      success: true,
      message: 'Live status fetched successfully',
      data: response
    });

  } catch (error) {
    console.error('❌ Error in /dashboard/live-status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

router.get('/dashboard/all-time-active', authMiddleware, async (req, res) => {
  try {
    // Helper functions
    const formatToIST = (date) => {
      return date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$2-$1');
    };

    const formatDuration = (ms) => {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    const now = new Date();
    const allTimeActiveVehicles = await Vehicle.find({ exitTime: null }).sort({ entryTime: -1 });

    // Process stage data
    const vehicleStageInfo = {};
    const stageMap = {};

    for (const vehicle of allTimeActiveVehicles) {
      const { vehicleNumber, stages } = vehicle;
      vehicleStageInfo[vehicleNumber] = {};

      // Find last active stage
      const lastStage = stages.reduce((latest, stage) => {
        if (!latest || stage.timestamp > latest.timestamp) {
          return stage;
        }
        return latest;
      }, null);

      if (lastStage) {
        vehicleStageInfo[vehicleNumber].lastStage = {
          stageName: lastStage.stageName,
          timestamp: formatToIST(lastStage.timestamp),
          performedBy: lastStage.performedBy?.userName || 'Unknown',
          duration: formatDuration(now - lastStage.timestamp)
        };
      }

      // Build stage-wise distribution
      for (const stage of stages) {
        if (!stageMap[stage.stageName]) {
          stageMap[stage.stageName] = [];
        }
        if (stage.eventType === 'Start' && !stages.some(s => 
          s.stageName === stage.stageName && 
          s.eventType === 'End' && 
          s.timestamp > stage.timestamp
        )) {
          stageMap[stage.stageName].push({
            vehicleNumber,
            startedAt: formatToIST(stage.timestamp),
            performedBy: stage.performedBy?.userName || 'Unknown',
            duration: formatDuration(now - stage.timestamp)
          });
        }
      }
    }

    const response = {
      count: allTimeActiveVehicles.length,
      vehicles: allTimeActiveVehicles.map(v => ({
        vehicleNumber: v.vehicleNumber,
        entryTime: formatToIST(v.entryTime),
        lastStage: vehicleStageInfo[v.vehicleNumber]?.lastStage || null,
        duration: formatDuration(now - v.entryTime),
        durationHours: Math.round((now - v.entryTime) / 3600000)
      })),
      stageWiseDistribution: stageMap,
      updatedAt: formatToIST(now)
    };

    res.status(200).json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error('❌ Error in /dashboard/all-time-active:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

router.get('/dashboard/todays-vehicles', authMiddleware, async (req, res) => {
  try {
    // Helper functions
    const formatToIST = (date) => {
      return date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$2-$1');
    };

    const formatDuration = (ms) => {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const todaysVehicles = await Vehicle.find({
      entryTime: { $gte: startOfToday }
    }).sort({ entryTime: -1 });

    // Process vehicle data
    const processedVehicles = todaysVehicles.map(v => {
      const durationMs = v.exitTime ? v.exitTime - v.entryTime : now - v.entryTime;
      
      // Find last stage
      const lastStage = v.stages.reduce((latest, stage) => {
        if (!latest || stage.timestamp > latest.timestamp) {
          return stage;
        }
        return latest;
      }, null);

      return {
        vehicleNumber: v.vehicleNumber,
        entryTime: formatToIST(v.entryTime),
        exitTime: v.exitTime ? formatToIST(v.exitTime) : null,
        isActive: !v.exitTime,
        lastStage: lastStage ? {
          stageName: lastStage.stageName,
          timestamp: formatToIST(lastStage.timestamp),
          performedBy: lastStage.performedBy?.userName || 'Unknown',
          eventType: lastStage.eventType,
          duration: formatDuration(now - lastStage.timestamp)
        } : null,
        duration: formatDuration(durationMs),
        durationMinutes: Math.round(durationMs / 60000)
      };
    });

    const response = {
      count: todaysVehicles.length,
      activeCount: processedVehicles.filter(v => v.isActive).length,
      completedCount: processedVehicles.filter(v => !v.isActive).length,
      vehicles: processedVehicles,
      updatedAt: formatToIST(now)
    };

    res.status(200).json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error('❌ Error in /dashboard/todays-vehicles:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});
//correct hai ye
router.get("/dashboard/stage-live-status", authMiddleware, async (req, res) => {
  try {
    const {
      startDate,
      endDate
    } = req.query;

    const start = startDate ? new Date(startDate) : new Date(new Date().setHours(0, 0, 0, 0));
    const end = endDate ? new Date(endDate) : new Date();

    const stagesWithStartEnd = [
      "Interactive Bay",
      "Bay Work",
      "Final Inspection",
      "Washing",
      "Creation of Parts Estimate"
    ];

    const stagesWithOnlyStart = [
      "Job Card Creation + Customer Approval",
      "Job Card Received + Bay Allocation",
      "Additional Work Job Approval",
      "Ready for Washing"
    ];

    const format = (date) => new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const vehicles = await Vehicle.find({
      entryTime: { $gte: start, $lte: end }
    });

    const result = {};

    // Initialize structure
    [...stagesWithStartEnd, ...stagesWithOnlyStart].forEach(stage => {
      result[stage] = {
        active: [],
        completed: []
      };
    });

    for (const vehicle of vehicles) {
      const { vehicleNumber, stages } = vehicle;

      // Handle Start-End stages
      for (const stage of stagesWithStartEnd) {
        const starts = stages.filter(s => s.stageName.startsWith(stage) && s.eventType === "Start");
        const ends = stages.filter(s => s.stageName.startsWith(stage) && s.eventType === "End");

        for (const startEvent of starts) {
          const hasEnd = ends.find(e => e.timestamp > startEvent.timestamp);

          const stageInfo = {
            vehicleNumber,
            startTime: format(startEvent.timestamp),
            performedBy: startEvent.performedBy?.userName || "Unknown"
          };

          if (hasEnd) {
            result[stage].completed.push({
              ...stageInfo,
              endTime: format(hasEnd.timestamp)
            });
          } else {
            result[stage].active.push(stageInfo);
          }
        }
      }

      // Handle only-Start stages
      for (const stage of stagesWithOnlyStart) {
        const starts = stages.filter(s => s.stageName.startsWith(stage) && s.eventType === "Start");

        for (const startEvent of starts) {
          // Check for next step (any stage started after this one)
          const hasNext = stages.some(s =>
            s.eventType === "Start" &&
            s.timestamp > startEvent.timestamp
          );

          const entry = {
            vehicleNumber,
            startTime: format(startEvent.timestamp),
            performedBy: startEvent.performedBy?.userName || "Unknown"
          };

          if (hasNext) {
            result[stage].completed.push(entry);
          } else {
            result[stage].active.push(entry);
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Live stage-wise status fetched successfully",
      data: result
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/stage-live-status:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});

const utils = {
  formatDuration: (milliseconds) => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [hours, mins, secs].map(n => n.toString().padStart(2, '0')).join(':');
  },
  
  formatMinutes: (minutes) => {
    const totalSeconds = Math.floor(minutes * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [hours, mins, secs].map(n => n.toString().padStart(2, '0')).join(':');
  },
  
  formatMilliseconds: (ms) => utils.formatMinutes(ms / 60000),
  
  getDateRanges: () => {
    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    
    return {
      today: { start: startOfDay, end: new Date() },
      thisWeek: { start: startOfWeek, end: new Date() },
      thisMonth: { start: startOfMonth, end: new Date() },
      lastMonth: { start: startOfLastMonth, end: endOfLastMonth }
    };
  },
  
  standardResponse: (res, success, message, data) => {
    return res.status(success ? 200 : 500).json({
      success,
      message,
      data: data || {}
    });
  },
  
  handleError: (res, error, endpoint) => {
    console.error(`❌ Error in ${endpoint}:`, error);
    return utils.standardResponse(
      res, 
      false, 
      "Server error", 
      { error: error.message }
    );
  }
};

// Define the stage order for consistent display
const stageOrder = [
  "Interactive Bay",
  "Job Card Creation + Customer Approval", 
  "Job Card Received + Bay Allocation",
  "Bay Work",
  "Additional Work Job Approval",
  "Creation of Parts Estimate",
  "Final Inspection",
  "Ready for Washing",
  "Washing"
];

// Helper function to sort objects by stage name based on the predefined order
const sortByStageOrder = (obj) => {
  const result = {};
  
  // Go through the stageOrder array and add matching stages to the result
  stageOrder.forEach(stageName => {
    if (obj.hasOwnProperty(stageName)) {
      result[stageName] = obj[stageName];
    }
  });
  
  // Add any remaining stages that weren't in the predefined order
  Object.keys(obj).forEach(key => {
    if (!result.hasOwnProperty(key)) {
      result[key] = obj[key];
    }
  });
  
  return result;
};

// Main dashboard route
router.get("/dashboard/metrics", authMiddleware, async (req, res) => {
  try {
    const { metricType = "all" } = req.query;
    const result = {};
    
    const dateRanges = utils.getDateRanges();
    const timePeriods = Object.keys(dateRanges);
    
    // Calculate requested metrics
    if (metricType === "all" || metricType === "stage-averages") {
      result.stageAverages = await calculateStageAverages(dateRanges, timePeriods);
    }
    
    if (metricType === "all" || metricType === "special-stage-averages") {
      result.specialStageAverages = await calculateSpecialStageAverages(dateRanges, timePeriods);
    }
    
    if (metricType === "all" || metricType === "job-card-received") {
      result.jobCardReceivedMetrics = await calculateJobCardReceivedMetrics(dateRanges, timePeriods);
    }
    
    if (metricType === "all" || metricType === "bay-work") {
      result.bayWorkMetrics = await calculateBayWorkMetrics(dateRanges, timePeriods);
    }
    
    // Apply stage ordering to all result objects
    if (result.stageAverages) {
      for (const period in result.stageAverages) {
        result.stageAverages[period] = sortByStageOrder(result.stageAverages[period]);
      }
    }
    
    if (result.specialStageAverages) {
      for (const period in result.specialStageAverages) {
        result.specialStageAverages[period] = sortByStageOrder(result.specialStageAverages[period]);
      }
    }
    
    return utils.standardResponse(
      res,
      true,
      `Dashboard metrics calculated successfully${metricType !== "all" ? ` for ${metricType}` : ""}`,
      result
    );
  } catch (error) {
    return utils.handleError(res, error, "/dashboard/metrics");
  }
});

// Metric calculation functions
async function calculateStageAverages(dateRanges, timePeriods) {
  // Updated to include all stages in the desired order
  const trackedStages = [
    "Interactive Bay", 
    "Job Card Creation + Customer Approval",
    "Job Card Received + Bay Allocation",
    "Bay Work",
    "Additional Work Job Approval",
    "Creation of Parts Estimate",
    "Final Inspection",
    "Ready for Washing",
    "Washing"
  ];

  const result = {};
  timePeriods.forEach(period => {
    result[period] = {};
    trackedStages.forEach(stage => {
      result[period][stage] = {
        totalDurationMs: 0,
        count: 0,
        details: []
      };
    });
  });

  for (const period of timePeriods) {
    const { start, end } = dateRanges[period];

    const vehicles = await Vehicle.find({
      "stages.timestamp": { $gte: start, $lte: end },
      "stages.stageName": { $in: trackedStages }
    });

    for (const vehicle of vehicles) {
      trackedStages.forEach(stageName => {
        const stageEvents = vehicle.stages
          .filter(s => s.stageName === stageName && s.timestamp >= start && s.timestamp <= end)
          .sort((a, b) => a.timestamp - b.timestamp);

        const starts = stageEvents.filter(e => e.eventType === "Start");
        const ends = stageEvents.filter(e => e.eventType === "End");

        starts.forEach(startEvent => {
          const endEvent = ends.find(e => e.timestamp > startEvent.timestamp);
          if (endEvent) {
            const durationMs = endEvent.timestamp - startEvent.timestamp;
            result[period][stageName].totalDurationMs += durationMs;
            result[period][stageName].count++;

            result[period][stageName].details.push({
              vehicleNumber: vehicle.vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: endEvent.timestamp,
              duration: utils.formatMilliseconds(durationMs)
            });
          }
        });
      });
    }
  }

  // Format result with durations and averages
  const formattedResult = {};
  timePeriods.forEach(period => {
    const periodResult = {};
    trackedStages.forEach(stageName => {
      const stageData = result[period][stageName];
      const avg = stageData.count > 0
        ? utils.formatMilliseconds(stageData.totalDurationMs / stageData.count)
        : "00:00:00";

      periodResult[stageName] = {
        totalDuration: utils.formatMilliseconds(stageData.totalDurationMs),
        count: stageData.count,
        average: avg,
        details: stageData.details
      };
    });
    formattedResult[period] = sortByStageOrder(periodResult);
  });

  return formattedResult;
}

async function calculateSpecialStageAverages(dateRanges, timePeriods) {
  // Updated special stages to align with the desired order
  const specialStages = [
    "Job Card Creation + Customer Approval",
    "Additional Work Job Approval",
    "Ready for Washing"
  ];

  const result = {};
  timePeriods.forEach(period => {
    result[period] = {};
    specialStages.forEach(stage => {
      result[period][stage] = {
        totalDurationMs: 0,
        totalDurationFormatted: "00:00:00",
        count: 0,
        averageMs: 0,
        averageFormatted: "00:00:00",
        details: []
      };
    });
  });

  for (const period of timePeriods) {
    const { start, end } = dateRanges[period];

    const vehicles = await Vehicle.find({
      "stages.timestamp": { $gte: start, $lte: end },
      "stages.stageName": {
        $in: [
          ...specialStages,
          "Job Card Received + Bay Allocation",
          "Bay Work",
          "Washing"
        ]
      }
    });

    vehicles.forEach(vehicle => {
      const vehicleStages = vehicle.stages
        .filter(s => s.timestamp >= start && s.timestamp <= end)
        .sort((a, b) => a.timestamp - b.timestamp);

      const vehicleNumber = vehicle.vehicleNumber;

      // Job Card Creation + Customer Approval
      const jobCardStarts = vehicleStages.filter(
        s => s.stageName === "Job Card Creation + Customer Approval" && s.eventType === "Start"
      );

      jobCardStarts.forEach(startEvent => {
        const endEvent = vehicleStages.find(s =>
          s.stageName.startsWith("Job Card Received + Bay Allocation") &&
          s.eventType === "Start" &&
          s.timestamp > startEvent.timestamp
        );

        if (endEvent) {
          const duration = endEvent.timestamp - startEvent.timestamp;
          result[period]["Job Card Creation + Customer Approval"].totalDurationMs += duration;
          result[period]["Job Card Creation + Customer Approval"].count++;
          result[period]["Job Card Creation + Customer Approval"].details.push({
            vehicleNumber,
            startTime: startEvent.timestamp,
            endTime: endEvent.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      });

      // Additional Work Job Approval
      const additionalApprovalStarts = vehicleStages.filter(
        s => s.stageName.startsWith("Additional Work Job Approval") && s.eventType === "Start"
      );

      additionalApprovalStarts.forEach(startEvent => {
        const subsequentBayAllocations = vehicleStages.filter(s =>
          s.stageName.startsWith("Job Card Received + Bay Allocation") &&
          s.eventType === "Start" &&
          s.timestamp > startEvent.timestamp
        );

        if (subsequentBayAllocations.length >= 2) {
          const endEvent = subsequentBayAllocations[1];
          const duration = endEvent.timestamp - startEvent.timestamp;
          result[period]["Additional Work Job Approval"].totalDurationMs += duration;
          result[period]["Additional Work Job Approval"].count++;
          result[period]["Additional Work Job Approval"].details.push({
            vehicleNumber,
            startTime: startEvent.timestamp,
            endTime: endEvent.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      });

      // Ready for Washing
      const washingReadyStarts = vehicleStages.filter(
        s => s.stageName === "Ready for Washing" && s.eventType === "Start"
      );

      washingReadyStarts.forEach(startEvent => {
        const endEvent = vehicleStages.find(s =>
          s.stageName === "Washing" &&
          s.eventType === "Start" &&
          s.timestamp > startEvent.timestamp
        );

        if (endEvent) {
          const duration = endEvent.timestamp - startEvent.timestamp;
          result[period]["Ready for Washing"].totalDurationMs += duration;
          result[period]["Ready for Washing"].count++;
          result[period]["Ready for Washing"].details.push({
            vehicleNumber,
            startTime: startEvent.timestamp,
            endTime: endEvent.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      });
    });

    // Calculate average durations
    specialStages.forEach(stageName => {
      const stageData = result[period][stageName];
      if (stageData.count > 0) {
        stageData.averageMs = stageData.totalDurationMs / stageData.count;
        stageData.totalDurationFormatted = utils.formatDuration(stageData.totalDurationMs);
        stageData.averageFormatted = utils.formatDuration(stageData.averageMs);
      }
    });
  }

  // Final response
  const formattedResult = {};
  timePeriods.forEach(period => {
    const periodResult = {};
    specialStages.forEach(stageName => {
      const stageData = result[period][stageName];
      periodResult[stageName] = {
        totalDuration: stageData.totalDurationFormatted,
        count: stageData.count,
        average: stageData.averageFormatted,
        details: stageData.details
      };
    });
    formattedResult[period] = sortByStageOrder(periodResult);
  });

  return formattedResult;
}

async function calculateJobCardReceivedMetrics(dateRanges, timePeriods) {
  const jobCardMetrics = [
    "jobCardReceivedBayAllocation",
    "jobCardReceivedByTechnician",
    "jobCardReceivedByFI"
  ];

  const result = {};
  timePeriods.forEach(period => {
    result[period] = {
      jobCardReceivedBayAllocation: {
        totalDuration: "00:00:00",
        count: 0,
        average: "00:00:00",
        details: []
      },
      jobCardReceivedByTechnician: {
        totalDuration: "00:00:00",
        count: 0,
        average: "00:00:00",
        details: []
      },
      jobCardReceivedByFI: {
        totalDuration: "00:00:00",
        count: 0,
        average: "00:00:00",
        details: []
      }
    };
  });

  for (const period of timePeriods) {
    const { start, end } = dateRanges[period];
    const vehicles = await Vehicle.find({
      "stages.timestamp": { $gte: start, $lte: end }
    });

    for (const vehicle of vehicles) {
      const vehicleStages = vehicle.stages.filter(
        s => s.timestamp >= start && s.timestamp <= end
      );

      // Job Card Received + Bay Allocation
      const jcReceivedStarts = vehicleStages.filter(
        s => s.stageName.startsWith("Job Card Received + Bay Allocation") &&
             s.eventType === "Start"
      );

      for (const startEvent of jcReceivedStarts) {
        const nextBayWork = vehicleStages.find(s =>
          s.stageName.startsWith("Bay Work") &&
          s.eventType === "Start" &&
          s.timestamp > startEvent.timestamp
        );

        if (nextBayWork) {
          const duration = nextBayWork.timestamp - startEvent.timestamp;
          result[period].jobCardReceivedBayAllocation.details.push({
            vehicleNumber: vehicle.vehicleNumber,
            startTime: startEvent.timestamp,
            endTime: nextBayWork.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      }

      // Job Card Received (by Technician)
      const technicianStarts = vehicleStages.filter(
        s => s.stageName === "Job Card Received (by Technician)" &&
             s.eventType === "Start"
      );

      for (const technicianEvent of technicianStarts) {
        const previousStage = vehicleStages.find(s =>
          s.stageName.startsWith("Job Card Received + Bay Allocation") &&
          s.eventType === "Start" &&
          s.timestamp < technicianEvent.timestamp
        );

        if (previousStage) {
          const duration = technicianEvent.timestamp - previousStage.timestamp;
          result[period].jobCardReceivedByTechnician.details.push({
            vehicleNumber: vehicle.vehicleNumber,
            startTime: previousStage.timestamp,
            endTime: technicianEvent.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      }

      // Job Card Received (by FI)
      const fiStarts = vehicleStages.filter(
        s => s.stageName === "Job Card Received (by FI)" &&
             s.eventType === "Start"
      );

      for (const fiEvent of fiStarts) {
        const previousTechnicianStage = vehicleStages.find(s =>
          s.stageName === "Job Card Received (by Technician)" &&
          s.eventType === "Start" &&
          s.timestamp < fiEvent.timestamp
        );

        if (previousTechnicianStage) {
          const duration = fiEvent.timestamp - previousTechnicianStage.timestamp;
          result[period].jobCardReceivedByFI.details.push({
            vehicleNumber: vehicle.vehicleNumber,
            startTime: previousTechnicianStage.timestamp,
            endTime: fiEvent.timestamp,
            duration: utils.formatDuration(duration)
          });
        }
      }
    }

    // Final formatting: count, total, average
    Object.keys(result[period]).forEach(stage => {
      const items = result[period][stage].details;
      const count = items.length;
      if (count > 0) {
        const totalMs = items.reduce((sum, d) => {
          const [h, m, s] = d.duration.split(':').map(Number);
          return sum + ((h * 3600 + m * 60 + s) * 1000);
        }, 0);

        const avgMs = totalMs / count;
        result[period][stage].count = count;
        result[period][stage].totalDuration = utils.formatDuration(totalMs);
        result[period][stage].average = utils.formatDuration(avgMs);
      }
    });
  }

  // Order the job card metrics according to related stage sequence
  const formattedResult = {};
  timePeriods.forEach(period => {
    formattedResult[period] = {};
    jobCardMetrics.forEach(metricName => {
      formattedResult[period][metricName] = result[period][metricName];
    });
  });

  return formattedResult;
}

async function calculateBayWorkMetrics(dateRanges, timePeriods) {
  const result = {};
  timePeriods.forEach(period => {
    result[period] = {
      byWorkType: {},
      overall: {
        totalDurationMs: 0,
        totalPausedDurationMs: 0,
        totalActiveDurationMs: 0,
        count: 0,
        details: []
      }
    };
  });

  for (const period of timePeriods) {
    const { start, end } = dateRanges[period];

    const vehicles = await Vehicle.find({
      "stages.timestamp": { $gte: start, $lte: end },
      "stages.stageName": { $regex: /^Bay Work:/ }
    });

    for (const vehicle of vehicles) {
      const bayWorkStages = vehicle.stages
        .filter(s => s.stageName.startsWith("Bay Work:") && s.timestamp >= start && s.timestamp <= end)
        .sort((a, b) => a.timestamp - b.timestamp);

      const workGroups = {};
      bayWorkStages.forEach(stage => {
        const { workType, bayNumber } = stage;
        if (!workType || !bayNumber) return;
        const key = `${workType}-${bayNumber}`;
        if (!workGroups[key]) {
          workGroups[key] = { workType, bayNumber, stages: [] };
        }
        workGroups[key].stages.push(stage);
      });

      for (const [_, group] of Object.entries(workGroups)) {
        const { workType, stages } = group;

        if (!result[period].byWorkType[workType]) {
          result[period].byWorkType[workType] = {
            totalDurationMs: 0,
            totalPausedDurationMs: 0,
            totalActiveDurationMs: 0,
            count: 0,
            details: []
          };
        }

        const starts = stages.filter(s => s.eventType === "Start");
        starts.forEach(startEvent => {
          const subsequent = stages.filter(s =>
            s.timestamp > startEvent.timestamp &&
            ["Pause", "Resume", "End"].includes(s.eventType)
          ).sort((a, b) => a.timestamp - b.timestamp);

          let endEvent = null;
          let lastTime = startEvent.timestamp;
          let paused = 0;
          let active = 0;
          let state = "active";

          for (const e of subsequent) {
            const duration = e.timestamp - lastTime;
            if (state === "active") active += duration;
            else paused += duration;

            if (e.eventType === "Pause") state = "paused";
            else if (e.eventType === "Resume") state = "active";
            else if (e.eventType === "End") {
              endEvent = e;
              break;
            }

            lastTime = e.timestamp;
          }

          if (endEvent) {
            const total = endEvent.timestamp - startEvent.timestamp;

            const detail = {
              vehicleNumber: vehicle.vehicleNumber,
              startTime: startEvent.timestamp,
              endTime: endEvent.timestamp,
              duration: utils.formatDuration(total)
            };

            // Update per work type
            result[period].byWorkType[workType].totalDurationMs += total;
            result[period].byWorkType[workType].totalPausedDurationMs += paused;
            result[period].byWorkType[workType].totalActiveDurationMs += active;
            result[period].byWorkType[workType].count++;
            result[period].byWorkType[workType].details.push(detail);

            // Update overall
            result[period].overall.totalDurationMs += total;
            result[period].overall.totalPausedDurationMs += paused;
            result[period].overall.totalActiveDurationMs += active;
            result[period].overall.count++;
            result[period].overall.details.push(detail);
          }
        });
      }
    }
  }

  // Format final output
  const formattedResult = {};
  timePeriods.forEach(period => {
    const overall = result[period].overall;
    formattedResult[period] = {
      byWorkType: {},
      overall: {
        totalDuration: utils.formatDuration(overall.totalDurationMs),
        activeDuration: utils.formatDuration(overall.totalActiveDurationMs),
        pausedDuration: utils.formatDuration(overall.totalPausedDurationMs),
        count: overall.count,
        average: overall.count > 0 ? utils.formatDuration(overall.totalActiveDurationMs / overall.count) : "00:00:00",
        details: overall.details
      }
    };

    // Sort work types based on predefined order if applicable
    const workTypes = Object.keys(result[period].byWorkType);
    const sortedWorkTypes = workTypes.sort(); // Simple alphabetical sort for work types
    
    sortedWorkTypes.forEach(workType => {
      const data = result[period].byWorkType[workType];
      formattedResult[period].byWorkType[workType] = {
        totalDuration: utils.formatDuration(data.totalDurationMs),
        activeDuration: utils.formatDuration(data.totalActiveDurationMs),
        pausedDuration: utils.formatDuration(data.totalPausedDurationMs),
        count: data.count,
        average: data.count > 0 ? utils.formatDuration(data.totalActiveDurationMs / data.count) : "00:00:00",
        details: data.details
      };
    });
  });

  return formattedResult;
}

router.get("/active-stages-with-duration", authMiddleware, async (req, res) => {
  try {
    const activeVehicles = await Vehicle.find({ exitTime: null })
      .sort({ entryTime: -1 })
      .lean();

    const now = new Date();
    
    const vehiclesWithActiveStages = activeVehicles.map(vehicle => {
      const stages = vehicle.stages || [];
      const activeStages = [];
      const stageStartTimes = {};

      // First pass to record all start times
      stages.forEach(stage => {
        if (stage.eventType === "Start") {
          // For dependent stages, we'll handle them specially in the next step
          if (!isDependentStage(stage.stageName)) {
            stageStartTimes[stage.stageName] = stage.timestamp;
          }
        } else if (stage.eventType === "End" && stageStartTimes[stage.stageName]) {
          delete stageStartTimes[stage.stageName];
        }
      });

      // Handle dependent stages
      const dependentStages = {
        // Job Card Creation + Customer Approval is implicitly ended by Ready for Washing
        'Job Card Creation + Customer Approval': {
          endedBy: stage => stage.stageName === 'Ready for Washing' && stage.eventType === 'Start',
          isActive: false
        },
        // Additional Work Approval is a one-time start without explicit end
        'Additional Work Job Approval': {
          endedBy: null, // No explicit end event
          isActive: stages.some(s => s.stageName.startsWith('Additional Work Job Approval') && s.eventType === 'Start')
        },
        // Ready for Washing is implicitly ended by Washing stage start
        'Ready for Washing': {
          endedBy: stage => stage.stageName === 'Washing' && stage.eventType === 'Start',
          isActive: false
        },
        // Job Card Received has multiple variants that are one-time starts
        'Job Card Received': {
          endedBy: null, // No explicit end event
          isActive: stages.some(s => (
            s.stageName.includes('Job Card Received') && 
            s.eventType === 'Start' &&
            !['Job Card Received + Bay Allocation'].some(exclude => s.stageName.includes(exclude))
          )
    )}
      };

      // Check dependent stages
      for (const [stagePattern, config] of Object.entries(dependentStages)) {
        // Find all matching start events
        const stageStarts = stages.filter(s => 
          s.stageName.includes(stagePattern) && 
          s.eventType === 'Start'
        );

        for (const startStage of stageStarts) {
          let isEnded = false;
          
          if (config.endedBy) {
            // Check if there's a stage that marks this as ended
            isEnded = stages.some(s => 
              config.endedBy(s) && 
              s.timestamp > startStage.timestamp
            );
          } else {
            // For stages without explicit end, use the config's isActive flag
            isEnded = !config.isActive;
          }

          if (!isEnded) {
            const durationMinutes = Math.round((now - startStage.timestamp) / (1000 * 60));
            activeStages.push({
              stageName: startStage.stageName,
              startedAt: startStage.timestamp,
              durationMinutes,
              durationFormatted: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
              startedBy: startStage.performedBy?.userName || 'Unknown',
              role: startStage.role,
              isDependentStage: true,
              ...(startStage.workType && { workType: startStage.workType }),
              ...(startStage.bayNumber && { bayNumber: startStage.bayNumber })
            });
          }
        }
      }

      // Handle regular stages (non-dependent)
      Object.entries(stageStartTimes).forEach(([stageName, startTime]) => {
        const startStage = stages.find(s => 
          s.stageName === stageName && 
          s.timestamp.getTime() === startTime.getTime()
        );
        
        if (startStage) {
          const durationMinutes = Math.round((now - startTime) / (1000 * 60));
          activeStages.push({
            stageName,
            startedAt: startTime,
            durationMinutes,
            durationFormatted: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
            startedBy: startStage.performedBy?.userName || 'Unknown',
            role: startStage.role,
            isDependentStage: false,
            ...(startStage.workType && { workType: startStage.workType }),
            ...(startStage.bayNumber && { bayNumber: startStage.bayNumber })
          });
        }
      });

      return {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        activeStages,
        totalActiveStages: activeStages.length
      };
    });

    // Helper function to identify dependent stages
    function isDependentStage(stageName) {
      return [
        'Job Card Creation + Customer Approval',
        'Additional Work Job Approval',
        'Ready for Washing',
        'Job Card Received'
      ].some(pattern => stageName.includes(pattern));
    }

    const result = vehiclesWithActiveStages.filter(v => v.totalActiveStages > 0);

    return res.status(200).json({
      success: true,
      count: result.length,
      vehicles: result
    });

  } catch (error) {
    console.error("❌ Error in /active-stages-with-duration:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});


router.get("/dashboard/interactive-bay", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Interactive Bay Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": "Interactive Bay",
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          interactiveBayStagesToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.stageName", "Interactive Bay"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          interactiveBayStagesAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: { $eq: ["$$stage.stageName", "Interactive Bay"] },
            },
          },
          securityGuardExitToday: {  // NEW FIELD: Find Security Guard Exit Today
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
           securityGuardExitAll: {  // NEW FIELD: Find Security Guard Exit All time
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          interactiveBayStagesToday: 1,
          interactiveBayStagesAll: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1, // Include the new field in the project
          securityGuardExitAll: 1, // Include the new field in the project
        },
      },
    ]);

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Today data
      const startsToday = vehicle.interactiveBayStagesToday.filter(
        (s) => s.eventType === "Start"
      );
      const endsToday = vehicle.interactiveBayStagesToday.filter(
        (s) => s.eventType === "End"
      );

      const latestStartToday = startsToday.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndToday = endsToday.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataToday = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartToday?.timestamp,
        endTime: latestEndToday?.timestamp,
        performedBy: latestStartToday?.performedBy?.userName || "Unknown",
      };

      // All time data
      const startsAll = vehicle.interactiveBayStagesAll.filter(
        (s) => s.eventType === "Start"
      );
      const endsAll = vehicle.interactiveBayStagesAll.filter(
        (s) => s.eventType === "End"
      );

      const latestStartAll = startsAll.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndAll = endsAll.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataAll = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartAll?.timestamp,
        endTime: latestEndAll?.timestamp,
        performedBy: latestStartAll?.performedBy?.userName || "Unknown",
      };

      // Security Guard Exit Check (TODAY)
      if (vehicle.securityGuardExitToday.length > 0 && !latestEndToday) {
        const securityExit = vehicle.securityGuardExitToday.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndToday = securityExit; // Use Security Guard's Exit Time
        vehicleDataToday.endTime = securityExit.timestamp; //Also update vehicle data
      }

       // Security Guard Exit Check (ALL)
      if (vehicle.securityGuardExitAll.length > 0 && !latestEndAll) {
        const securityExit = vehicle.securityGuardExitAll.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndAll = securityExit; // Use Security Guard's Exit Time
         vehicleDataAll.endTime = securityExit.timestamp; //Also update vehicle data
      }

      // Categorization (TODAY)
      if (isToday) {
        if (latestStartToday && latestEndToday && latestEndToday.timestamp > latestStartToday.timestamp) {
          completedToday.push({
            ...vehicleDataToday,
            durationMinutes: Math.round((latestEndToday.timestamp - latestStartToday.timestamp) / 60000),
          });
        } else {
          activeToday.push({
            ...vehicleDataToday,
            durationMinutes: latestStartToday
              ? Math.round((new Date() - latestStartToday.timestamp) / 60000)
              : 0,
          });
        }
      }

      // Categorization (ALL)
      if (isAll) {
        if (latestStartAll && latestEndAll && latestEndAll.timestamp > latestStartAll.timestamp) {
          completedAll.push({
            ...vehicleDataAll,
            durationMinutes: Math.round((latestEndAll.timestamp - latestStartAll.timestamp) / 60000),
          });
        } else {
          activeAll.push({
            ...vehicleDataAll,
            durationMinutes: latestStartAll
              ? Math.round((new Date() - latestStartAll.timestamp) / 60000)
              : 0,
          });
        }
      }
    });

    const getAverageDuration = (arr) => {
      const durations = arr.map((v) => v.durationMinutes);
      return durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    };

    const averageToday = getAverageDuration(completedToday);
    const averageAll = getAverageDuration(completedAll);
    const delayedToday = activeToday.filter((v) => v.durationMinutes > 20);
    const delayedAll = activeAll.filter((v) => v.durationMinutes > 20);

    const responseData = {
      stageName: "Interactive Bay",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          totalCompleted: completedToday.length,
          totalActive: activeToday.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageToday,
          delayedVehicles: delayedToday.length,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          totalCompleted: completedAll.length,
          totalActive: activeAll.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageAll,
          delayedVehicles: delayedAll.length,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/interactive-bay:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});


router.get("/dashboard/washing", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Washing Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": "Washing",
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          washingStagesToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.stageName", "Washing"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          washingStagesAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: { $eq: ["$$stage.stageName", "Washing"] },
            },
          },
          securityGuardExitToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          securityGuardExitAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          washingStagesToday: 1,
          washingStagesAll: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1,
          securityGuardExitAll: 1,
        },
      },
    ]);

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Today data
      const startsToday = vehicle.washingStagesToday.filter(
        (s) => s.eventType === "Start"
      );
      const endsToday = vehicle.washingStagesToday.filter(
        (s) => s.eventType === "End"
      );

      const latestStartToday = startsToday.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndToday = endsToday.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataToday = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartToday?.timestamp,
        endTime: latestEndToday?.timestamp,
        performedBy: latestStartToday?.performedBy?.userName || "Unknown",
      };

      // All time data
      const startsAll = vehicle.washingStagesAll.filter(
        (s) => s.eventType === "Start"
      );
      const endsAll = vehicle.washingStagesAll.filter(
        (s) => s.eventType === "End"
      );

      const latestStartAll = startsAll.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndAll = endsAll.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataAll = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartAll?.timestamp,
        endTime: latestEndAll?.timestamp,
        performedBy: latestStartAll?.performedBy?.userName || "Unknown",
      };

      // Security Guard Exit Check (TODAY)
      if (vehicle.securityGuardExitToday.length > 0 && !latestEndToday) {
        const securityExit = vehicle.securityGuardExitToday.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndToday = securityExit;
        vehicleDataToday.endTime = securityExit.timestamp;
      }

      // Security Guard Exit Check (ALL)
      if (vehicle.securityGuardExitAll.length > 0 && !latestEndAll) {
        const securityExit = vehicle.securityGuardExitAll.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndAll = securityExit;
        vehicleDataAll.endTime = securityExit.timestamp;
      }

      // Categorization (TODAY)
      if (isToday) {
        if (latestStartToday && latestEndToday && latestEndToday.timestamp > latestStartToday.timestamp) {
          completedToday.push({
            ...vehicleDataToday,
            durationMinutes: Math.round((latestEndToday.timestamp - latestStartToday.timestamp) / 60000),
          });
        } else {
          activeToday.push({
            ...vehicleDataToday,
            durationMinutes: latestStartToday
              ? Math.round((new Date() - latestStartToday.timestamp) / 60000)
              : 0,
          });
        }
      }

      // Categorization (ALL)
      if (isAll) {
        if (latestStartAll && latestEndAll && latestEndAll.timestamp > latestStartAll.timestamp) {
          completedAll.push({
            ...vehicleDataAll,
            durationMinutes: Math.round((latestEndAll.timestamp - latestStartAll.timestamp) / 60000),
          });
        } else {
          activeAll.push({
            ...vehicleDataAll,
            durationMinutes: latestStartAll
              ? Math.round((new Date() - latestStartAll.timestamp) / 60000)
              : 0,
          });
        }
      }
    });

    const getAverageDuration = (arr) => {
      const durations = arr.map((v) => v.durationMinutes);
      return durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    };

    const averageToday = getAverageDuration(completedToday);
    const averageAll = getAverageDuration(completedAll);
    const delayedToday = activeToday.filter((v) => v.durationMinutes > 20);
    const delayedAll = activeAll.filter((v) => v.durationMinutes > 20);

    const responseData = {
      stageName: "Washing",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          totalCompleted: completedToday.length,
          totalActive: activeToday.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageToday,
          delayedVehicles: delayedToday.length,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          totalCompleted: completedAll.length,
          totalActive: activeAll.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageAll,
          delayedVehicles: delayedAll.length,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/washing:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

router.get("/dashboard/final-inspection", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Final Inspection Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": "Final Inspection",
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          finalInspectionStagesToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.stageName", "Final Inspection"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          finalInspectionStagesAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: { $eq: ["$$stage.stageName", "Final Inspection"] },
            },
          },
          securityGuardExitToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          securityGuardExitAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          finalInspectionStagesToday: 1,
          finalInspectionStagesAll: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1,
          securityGuardExitAll: 1,
        },
      },
    ]);

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Today data
      const startsToday = vehicle.finalInspectionStagesToday.filter(
        (s) => s.eventType === "Start"
      );
      const endsToday = vehicle.finalInspectionStagesToday.filter(
        (s) => s.eventType === "End"
      );

      const latestStartToday = startsToday.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndToday = endsToday.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataToday = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartToday?.timestamp,
        endTime: latestEndToday?.timestamp,
        performedBy: latestStartToday?.performedBy?.userName || "Unknown",
        inspectorName: latestStartToday?.inspectorName || null, // Added inspector name if available
      };

      // All time data
      const startsAll = vehicle.finalInspectionStagesAll.filter(
        (s) => s.eventType === "Start"
      );
      const endsAll = vehicle.finalInspectionStagesAll.filter(
        (s) => s.eventType === "End"
      );

      const latestStartAll = startsAll.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndAll = endsAll.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataAll = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartAll?.timestamp,
        endTime: latestEndAll?.timestamp,
        performedBy: latestStartAll?.performedBy?.userName || "Unknown",
        inspectorName: latestStartAll?.inspectorName || null, // Added inspector name if available
      };

      // Security Guard Exit Check (TODAY)
      if (vehicle.securityGuardExitToday.length > 0 && !latestEndToday) {
        const securityExit = vehicle.securityGuardExitToday.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndToday = securityExit;
        vehicleDataToday.endTime = securityExit.timestamp;
      }

      // Security Guard Exit Check (ALL)
      if (vehicle.securityGuardExitAll.length > 0 && !latestEndAll) {
        const securityExit = vehicle.securityGuardExitAll.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndAll = securityExit;
        vehicleDataAll.endTime = securityExit.timestamp;
      }

      // Categorization (TODAY)
      if (isToday) {
        if (latestStartToday && latestEndToday && latestEndToday.timestamp > latestStartToday.timestamp) {
          completedToday.push({
            ...vehicleDataToday,
            durationMinutes: Math.round((latestEndToday.timestamp - latestStartToday.timestamp) / 60000),
            inspectionResult: latestEndToday?.inspectionResult || "Passed", // Added inspection result
          });
        } else {
          activeToday.push({
            ...vehicleDataToday,
            durationMinutes: latestStartToday
              ? Math.round((new Date() - latestStartToday.timestamp) / 60000)
              : 0,
          });
        }
      }

      // Categorization (ALL)
      if (isAll) {
        if (latestStartAll && latestEndAll && latestEndAll.timestamp > latestStartAll.timestamp) {
          completedAll.push({
            ...vehicleDataAll,
            durationMinutes: Math.round((latestEndAll.timestamp - latestStartAll.timestamp) / 60000),
            inspectionResult: latestEndAll?.inspectionResult || "Passed", // Added inspection result
          });
        } else {
          activeAll.push({
            ...vehicleDataAll,
            durationMinutes: latestStartAll
              ? Math.round((new Date() - latestStartAll.timestamp) / 60000)
              : 0,
          });
        }
      }
    });

    const getAverageDuration = (arr) => {
      const durations = arr.map((v) => v.durationMinutes);
      return durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    };

    const averageToday = getAverageDuration(completedToday);
    const averageAll = getAverageDuration(completedAll);
    const delayedToday = activeToday.filter((v) => v.durationMinutes > 30); // Increased delay threshold to 30 mins for inspection
    const delayedAll = activeAll.filter((v) => v.durationMinutes > 30);

    // Calculate pass/fail rates
    const calculatePassRate = (arr) => {
      const total = arr.length;
      if (total === 0) return 0;
      const passed = arr.filter(v => v.inspectionResult === "Passed").length;
      return Math.round((passed / total) * 100);
    };

    const passRateToday = calculatePassRate(completedToday);
    const passRateAll = calculatePassRate(completedAll);

    const responseData = {
      stageName: "Final Inspection",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          totalCompleted: completedToday.length,
          totalActive: activeToday.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageToday,
          delayedVehicles: delayedToday.length,
          passRate: passRateToday,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          totalCompleted: completedAll.length,
          totalActive: activeAll.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageAll,
          delayedVehicles: delayedAll.length,
          passRate: passRateAll,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/final-inspection:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

router.get("/dashboard/parts-estimate", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Parts Estimate Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": "Creation of Parts Estimate",
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          partsEstimateStagesToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.stageName", "Creation of Parts Estimate"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          partsEstimateStagesAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: { $eq: ["$$stage.stageName", "Creation of Parts Estimate"] },
            },
          },
          securityGuardExitToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          securityGuardExitAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          partsEstimateStagesToday: 1,
          partsEstimateStagesAll: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1,
          securityGuardExitAll: 1,
        },
      },
    ]);

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Today data
      const startsToday = vehicle.partsEstimateStagesToday.filter(
        (s) => s.eventType === "Start"
      );
      const endsToday = vehicle.partsEstimateStagesToday.filter(
        (s) => s.eventType === "End"
      );

      const latestStartToday = startsToday.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndToday = endsToday.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataToday = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartToday?.timestamp,
        endTime: latestEndToday?.timestamp,
        performedBy: latestStartToday?.performedBy?.userName || "Unknown",
        partsCount: latestStartToday?.partsCount || 0, // Added parts count tracking
        estimateValue: latestStartToday?.estimateValue || 0, // Added estimate value
      };

      // All time data
      const startsAll = vehicle.partsEstimateStagesAll.filter(
        (s) => s.eventType === "Start"
      );
      const endsAll = vehicle.partsEstimateStagesAll.filter(
        (s) => s.eventType === "End"
      );

      const latestStartAll = startsAll.sort((a, b) => b.timestamp - a.timestamp)[0];
      let latestEndAll = endsAll.sort((a, b) => b.timestamp - a.timestamp)[0];

      const vehicleDataAll = {
        vehicleNumber: vehicle.vehicleNumber,
        entryTime: vehicle.entryTime,
        startTime: latestStartAll?.timestamp,
        endTime: latestEndAll?.timestamp,
        performedBy: latestStartAll?.performedBy?.userName || "Unknown",
        partsCount: latestStartAll?.partsCount || 0, // Added parts count tracking
        estimateValue: latestStartAll?.estimateValue || 0, // Added estimate value
      };

      // Security Guard Exit Check (TODAY)
      if (vehicle.securityGuardExitToday.length > 0 && !latestEndToday) {
        const securityExit = vehicle.securityGuardExitToday.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndToday = securityExit;
        vehicleDataToday.endTime = securityExit.timestamp;
      }

      // Security Guard Exit Check (ALL)
      if (vehicle.securityGuardExitAll.length > 0 && !latestEndAll) {
        const securityExit = vehicle.securityGuardExitAll.sort(
          (a, b) => b.timestamp - a.timestamp
        )[0];
        latestEndAll = securityExit;
        vehicleDataAll.endTime = securityExit.timestamp;
      }

      // Categorization (TODAY)
      if (isToday) {
        if (latestStartToday && latestEndToday && latestEndToday.timestamp > latestStartToday.timestamp) {
          completedToday.push({
            ...vehicleDataToday,
            durationMinutes: Math.round((latestEndToday.timestamp - latestStartToday.timestamp) / 60000),
          });
        } else {
          activeToday.push({
            ...vehicleDataToday,
            durationMinutes: latestStartToday
              ? Math.round((new Date() - latestStartToday.timestamp) / 60000)
              : 0,
          });
        }
      }

      // Categorization (ALL)
      if (isAll) {
        if (latestStartAll && latestEndAll && latestEndAll.timestamp > latestStartAll.timestamp) {
          completedAll.push({
            ...vehicleDataAll,
            durationMinutes: Math.round((latestEndAll.timestamp - latestStartAll.timestamp) / 60000),
          });
        } else {
          activeAll.push({
            ...vehicleDataAll,
            durationMinutes: latestStartAll
              ? Math.round((new Date() - latestStartAll.timestamp) / 60000)
              : 0,
          });
        }
      }
    });

    const getAverageDuration = (arr) => {
      const durations = arr.map((v) => v.durationMinutes);
      return durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    };

    const calculateTotalEstimateValue = (arr) => {
      return arr.reduce((total, vehicle) => total + (vehicle.estimateValue || 0), 0);
    };

    const calculateAveragePartsCount = (arr) => {
      const counts = arr.map(v => v.partsCount || 0);
      return counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0;
    };

    const averageToday = getAverageDuration(completedToday);
    const averageAll = getAverageDuration(completedAll);
    const delayedToday = activeToday.filter((v) => v.durationMinutes > 15); // Reduced delay threshold to 15 mins for parts estimate
    const delayedAll = activeAll.filter((v) => v.durationMinutes > 15);

    const totalEstimateToday = calculateTotalEstimateValue(completedToday);
    const totalEstimateAll = calculateTotalEstimateValue(completedAll);
    const avgPartsToday = calculateAveragePartsCount(completedToday);
    const avgPartsAll = calculateAveragePartsCount(completedAll);

    const responseData = {
      stageName: "Creation of Parts Estimate",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          totalCompleted: completedToday.length,
          totalActive: activeToday.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageToday,
          delayedVehicles: delayedToday.length,
          totalEstimateValue: totalEstimateToday,
          averagePartsCount: avgPartsToday,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          totalCompleted: completedAll.length,
          totalActive: activeAll.length,
          totalProcessed: vehicles.length,
          averageDurationMinutes: averageAll,
          delayedVehicles: delayedAll.length,
          totalEstimateValue: totalEstimateAll,
          averagePartsCount: avgPartsAll,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/parts-estimate:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

router.get("/dashboard/bay-work", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Bay Work Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": { $regex: /^Bay Work:/ },
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          bayWorkStagesToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $regexMatch: { input: "$$stage.stageName", regex: /^Bay Work:/ } },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          bayWorkStagesAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: { $regexMatch: { input: "$$stage.stageName", regex: /^Bay Work:/ } },
            },
          },
          securityGuardExitToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          securityGuardExitAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          bayWorkStagesToday: 1,
          bayWorkStagesAll: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1,
          securityGuardExitAll: 1,
        },
      },
    ]);

    const processBayWorkStages = (stages, workType, bayNumber) => {
      const workStages = stages.filter(stage => 
        stage.stageName.startsWith(`Bay Work: ${workType}`) && 
        stage.bayNumber == bayNumber
      );

      const startEvents = workStages.filter(s => s.eventType === "Start");
      const endEvents = workStages.filter(s => s.eventType === "End");
      const pauseEvents = workStages.filter(s => s.eventType === "Pause");
      const resumeEvents = workStages.filter(s => s.eventType === "Resume");

      const latestStart = [...startEvents].sort((a, b) => b.timestamp - a.timestamp)[0];
      const latestEnd = [...endEvents].sort((a, b) => b.timestamp - a.timestamp)[0];

      let totalPausedTime = 0;
      let activeTime = 0;
      let currentStatus = latestStart && !latestEnd ? "active" : "completed";

      // Calculate paused time
      if (latestStart) {
        const endReference = latestEnd ? latestEnd.timestamp : new Date();
        
        // Pair up pauses and resumes
        let pausePairs = [];
        let i = 0, j = 0;
        
        while (i < pauseEvents.length && j < resumeEvents.length) {
          if (pauseEvents[i].timestamp > latestStart.timestamp) {
            if (resumeEvents[j].timestamp > pauseEvents[i].timestamp) {
              pausePairs.push({
                pause: pauseEvents[i].timestamp,
                resume: resumeEvents[j].timestamp
              });
              i++;
              j++;
            } else {
              j++;
            }
          } else {
            i++;
          }
        }

        // Handle any remaining pause without resume
        if (i < pauseEvents.length && pauseEvents[i].timestamp > latestStart.timestamp) {
          pausePairs.push({
            pause: pauseEvents[i].timestamp,
            resume: endReference
          });
        }

        // Calculate total paused time
        totalPausedTime = pausePairs.reduce((total, pair) => {
          return total + (pair.resume - pair.pause);
        }, 0);

        // Calculate active working time
        activeTime = (endReference - latestStart.timestamp) - totalPausedTime;
      }

      return {
        workType,
        bayNumber,
        startTime: latestStart?.timestamp,
        endTime: latestEnd?.timestamp,
        performedBy: latestStart?.performedBy?.userName || "Unknown",
        totalDuration: latestStart && latestEnd ? (latestEnd.timestamp - latestStart.timestamp) : 0,
        activeDuration: activeTime,
        pausedDuration: totalPausedTime,
        status: currentStatus,
        pauseCount: pauseEvents.length,
      };
    };

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Group by workType and bayNumber
      const workGroups = {};
      
      // Process today's data
      if (isToday) {
        vehicle.bayWorkStagesToday.forEach(stage => {
          if (stage.workType && stage.bayNumber != null) {
            const key = `${stage.workType}_${stage.bayNumber}`;
            if (!workGroups[key]) {
              workGroups[key] = {
                workType: stage.workType,
                bayNumber: stage.bayNumber,
                stagesToday: [],
                stagesAll: []
              };
            }
            workGroups[key].stagesToday.push(stage);
          }
        });
      }

      // Process all time data
      if (isAll) {
        vehicle.bayWorkStagesAll.forEach(stage => {
          if (stage.workType && stage.bayNumber != null) {
            const key = `${stage.workType}_${stage.bayNumber}`;
            if (!workGroups[key]) {
              workGroups[key] = {
                workType: stage.workType,
                bayNumber: stage.bayNumber,
                stagesToday: [],
                stagesAll: []
              };
            }
            workGroups[key].stagesAll.push(stage);
          }
        });
      }

      // Process each work group
      Object.values(workGroups).forEach(group => {
        const vehicleBaseData = {
          vehicleNumber: vehicle.vehicleNumber,
          entryTime: vehicle.entryTime,
        };

        // Today data
        if (isToday && group.stagesToday.length > 0) {
          const workData = processBayWorkStages(
            group.stagesToday, 
            group.workType, 
            group.bayNumber
          );

          const vehicleData = {
            ...vehicleBaseData,
            ...workData,
            durationMinutes: Math.round(workData.activeDuration / 60000),
            pausedMinutes: Math.round(workData.pausedDuration / 60000),
          };

          if (workData.status === "completed") {
            completedToday.push(vehicleData);
          } else {
            activeToday.push(vehicleData);
          }
        }

        // All time data
        if (isAll && group.stagesAll.length > 0) {
          const workData = processBayWorkStages(
            group.stagesAll, 
            group.workType, 
            group.bayNumber
          );

          const vehicleData = {
            ...vehicleBaseData,
            ...workData,
            durationMinutes: Math.round(workData.activeDuration / 60000),
            pausedMinutes: Math.round(workData.pausedDuration / 60000),
          };

          if (workData.status === "completed") {
            completedAll.push(vehicleData);
          } else {
            activeAll.push(vehicleData);
          }
        }
      });
    });

    // Calculate statistics
    const calculateStats = (completed, active) => {
      const durations = completed.map(v => v.durationMinutes);
      const pausedTimes = completed.map(v => v.pausedMinutes);
      const pauseCounts = completed.map(v => v.pauseCount);

      return {
        totalCompleted: completed.length,
        totalActive: active.length,
        averageDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
        averagePausedTime: pausedTimes.length ? Math.round(pausedTimes.reduce((a, b) => a + b, 0) / pausedTimes.length) : 0,
        averagePauses: pauseCounts.length ? Math.round(pauseCounts.reduce((a, b) => a + b, 0) / pauseCounts.length) : 0,
        efficiency: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / 
          (durations.reduce((a, b) => a + b, 0) + pausedTimes.reduce((a, b) => a + b, 0)) * 100)) : 0,
      };
    };

    const statsToday = calculateStats(completedToday, activeToday);
    const statsAll = calculateStats(completedAll, activeAll);

    const delayedToday = activeToday.filter(v => v.durationMinutes > 120); // 2 hour threshold for bay work
    const delayedAll = activeAll.filter(v => v.durationMinutes > 120);

    const responseData = {
      stageName: "Bay Work",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          ...statsToday,
          delayedVehicles: delayedToday.length,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          ...statsAll,
          delayedVehicles: delayedAll.length,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/bay-work:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

router.get("/dashboard/job-card-creation", authMiddleware, async (req, res) => {
  try {
    const { filter = "today" } = req.query;
    console.log("🔍 Requested Job Card Creation Dashboard with Filter:", filter);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const isToday = filter === "today";
    const isAll = filter === "all";

    const baseMatch = {
      "stages.stageName": "Job Card Creation + Customer Approval",
    };

    if (isToday) {
      baseMatch["stages.timestamp"] = { $gte: todayStart, $lte: todayEnd };
    }

    const vehicles = await Vehicle.aggregate([
      { $match: baseMatch },
      {
        $addFields: {
          jobCardCreationStages: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $eq: ["$$stage.stageName", "Job Card Creation + Customer Approval"]
              },
            },
          },
          jobCardReceivedStages: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $regexMatch: { input: "$$stage.stageName", regex: /^Job Card Received \+ Bay Allocation/ }
              },
            },
          },
          securityGuardExitToday: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                  { $gte: ["$$stage.timestamp", todayStart] },
                  { $lte: ["$$stage.timestamp", todayEnd] },
                ],
              },
            },
          },
          securityGuardExitAll: {
            $filter: {
              input: "$stages",
              as: "stage",
              cond: {
                $and: [
                  { $eq: ["$$stage.role", "Security Guard"] },
                  { $eq: ["$$stage.eventType", "End"] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          vehicleNumber: 1,
          entryTime: 1,
          exitTime: 1,
          jobCardCreationStages: 1,
          jobCardReceivedStages: 1,
          isActive: { $eq: ["$exitTime", null] },
          securityGuardExitToday: 1,
          securityGuardExitAll: 1,
        },
      },
    ]);

    const completedToday = [];
    const activeToday = [];
    const completedAll = [];
    const activeAll = [];

    vehicles.forEach((vehicle) => {
      // Get all job card creation starts
      const creationStarts = vehicle.jobCardCreationStages.filter(
        (s) => s.eventType === "Start"
      );
      
      // Get all job card received starts
      const receivedStarts = vehicle.jobCardReceivedStages.filter(
        (s) => s.eventType === "Start"
      ).sort((a, b) => a.timestamp - b.timestamp); // Sort by earliest first

      // Process each job card creation start
      creationStarts.forEach(creationStart => {
        const creationTime = creationStart.timestamp;
        const firstReceivedAfterCreation = receivedStarts.find(
          received => received.timestamp > creationTime
        );

        const vehicleData = {
          vehicleNumber: vehicle.vehicleNumber,
          entryTime: vehicle.entryTime,
          creationStartTime: creationTime,
          creationPerformedBy: creationStart.performedBy?.userName || "Unknown",
          firstReceivedTime: firstReceivedAfterCreation?.timestamp || null,
          receivedPerformedBy: firstReceivedAfterCreation?.performedBy?.userName || null,
        };

        // Calculate duration if received exists
        if (firstReceivedAfterCreation) {
          const durationMinutes = Math.round(
            (firstReceivedAfterCreation.timestamp - creationTime) / 60000
          );
          
          const dataWithDuration = {
            ...vehicleData,
            durationMinutes,
          };

          if (isToday && creationTime >= todayStart && creationTime <= todayEnd) {
            completedToday.push(dataWithDuration);
          }
          if (isAll) {
            completedAll.push(dataWithDuration);
          }
        } else {
          // No received yet - active job
          const durationMinutes = Math.round(
            (new Date() - creationTime) / 60000
          );
          
          const activeData = {
            ...vehicleData,
            durationMinutes,
          };

          if (isToday && creationTime >= todayStart && creationTime <= todayEnd) {
            activeToday.push(activeData);
          }
          if (isAll) {
            activeAll.push(activeData);
          }
        }
      });
    });

    // Calculate statistics
    const getAverageDuration = (arr) => {
      const durations = arr.map((v) => v.durationMinutes);
      return durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    };

    const averageToday = getAverageDuration(completedToday);
    const averageAll = getAverageDuration(completedAll);
    const delayedToday = activeToday.filter((v) => v.durationMinutes > 30); // 30 minute threshold
    const delayedAll = activeAll.filter((v) => v.durationMinutes > 30);

    const responseData = {
      stageName: "Job Card Creation + Customer Approval",
      filter,
      lastUpdated: new Date(),
    };

    if (isToday) {
      responseData.today = {
        summary: {
          totalCompleted: completedToday.length,
          totalActive: activeToday.length,
          averageDurationMinutes: averageToday,
          delayedVehicles: delayedToday.length,
        },
        completedVehicles: completedToday,
        activeVehicles: activeToday,
        delayedVehicles: delayedToday,
      };
    } else if (isAll) {
      responseData.allTime = {
        summary: {
          totalCompleted: completedAll.length,
          totalActive: activeAll.length,
          averageDurationMinutes: averageAll,
          delayedVehicles: delayedAll.length,
        },
        completedVehicles: completedAll,
        activeVehicles: activeAll,
        delayedVehicles: delayedAll,
      };
    }

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error in /dashboard/job-card-creation:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

















module.exports = router;
