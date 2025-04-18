router.get("/dashboard/live-status", authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const activeVehicles = await Vehicle.find({ exitTime: null });

    const todayVehicles = await Vehicle.find({
      entryTime: { $gte: startOfToday }
    });

    const stageMap = {};

    for (const vehicle of activeVehicles) {
      const { vehicleNumber, stages } = vehicle;

      const stageGroups = {};

      // Group stages by stageName
      for (const stage of stages) {
        if (!stageGroups[stage.stageName]) {
          stageGroups[stage.stageName] = [];
        }
        stageGroups[stage.stageName].push(stage);
      }

      // Process each stage group
      for (const [stageName, entries] of Object.entries(stageGroups)) {
        const starts = entries
          .filter(s => s.eventType === "Start")
          .sort((a, b) => a.timestamp - b.timestamp);
        const ends = entries
          .filter(s => s.eventType === "End")
          .sort((a, b) => a.timestamp - b.timestamp);

        for (const start of starts) {
          const isEnded = ends.some(end => end.timestamp > start.timestamp);
          if (!isEnded) {
            if (!stageMap[stageName]) stageMap[stageName] = [];

            stageMap[stageName].push({
              vehicleNumber,
              startedAt: start.timestamp,
              performedBy: start.performedBy?.userName || "Unknown"
            });

            break; // Avoid duplicate active stages per vehicle per stageName
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      message: "Live status fetched successfully",
      data: {
        totalActiveVehicles: activeVehicles.length,
        todayEntries: todayVehicles.map(v => ({
          vehicleNumber: v.vehicleNumber,
          entryTime: v.entryTime
        })),
        liveStageStatus: stageMap
      }
    });

  } catch (error) {
    console.error("❌ Error in /dashboard/live-status:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
});



router.post("/vehicle-check", authMiddleware, async (req, res) => {
    console.log("🔹 Incoming Request Data:", req.body);
  
    try {
      let {
        vehicleNumber,
        role,
        stageName,
        eventType,
        inKM,
        outKM,
        inDriver,
        outDriver,
        workType,
        bayNumber,
      } = req.body;
  
      // Validate required fields
      if (!vehicleNumber || !stageName || !eventType) {
        return res.status(400).json({
          success: false,
          message: "Vehicle number, stage name and event type are required."
        });
      }
  
      // Validate user role matches the role in request
      if (req.user.role !== role) {
        return res.status(403).json({
          success: false,
          message: "Your user role doesn't match the requested action role"
        });
      }
  
      const formattedVehicleNumber = vehicleNumber.trim().toUpperCase();
  
      // Find the most recent active vehicle entry
      let vehicle = await Vehicle.findOne({
        vehicleNumber: formattedVehicleNumber,
        exitTime: null
      }).sort({ entryTime: -1 });
  
      // N-1 CALLING LOGIC - MUST BE PLACED BEFORE THE NEW VEHICLE ENTRY LOGIC
      if (role === "Service Advisor" && stageName === "N-1 Calling" && eventType === "Start") {
        if (!vehicle) {
            // If vehicle doesn't exist, create a new vehicle object
            vehicle = new Vehicle({
                vehicleNumber: formattedVehicleNumber,
                stages: [], // Initialize stages array
            });
        }
          // Check if N-1 Calling has already been started
          const alreadyCalled = vehicle?.stages?.some(stage =>  // Use optional chaining
            stage.stageName === "N-1 Calling" && stage.eventType === "Start"
          ) || false; // Default to false if vehicle or stages are null
    
          if (alreadyCalled) {
            return res.status(400).json({
              success: false,
              message: "N-1 Calling has already been started for this vehicle."
            });
          }
        
          // Generate tracking token if it doesn't already exist
          if (!vehicle.trackingToken) {  // Use optional chaining
            vehicle.trackingToken = crypto.randomBytes(16).toString('hex'); // Generates a unique token
            console.log("Generated tracking token: ", vehicle.trackingToken);
          } else {
            console.log("Existing tracking token: ", vehicle.trackingToken);
          }
    
          // Add the new stage to the vehicle's stages
          const newStage = {
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            }
          };
    
          // Push the new stage into the existing stages or initialize if stages is null
          vehicle.stages = vehicle.stages ? [...vehicle.stages, newStage] : [newStage];
        
          try {
            await vehicle.save();
          } catch (error) {
            console.error("Error saving vehicle:", error);
            return res.status(500).json({
              success: false,
              message: "Error saving vehicle",
              error: error
            });
          }
    
          // Generate the tracking link using vehicle's trackingToken
          const vehicleLink = `https://SilverStar.com/track/${vehicle.trackingToken}`;
          console.log("Generated vehicle link: ", vehicleLink);
    
          return res.status(200).json({
            success: true,
            message: "N-1 Calling recorded successfully",
            trackingLink: vehicleLink,
            vehicle: {
              ...vehicle.toObject(), // Convert to plain JS object
              stages: [newStage] // Only send the new stage
            }
          });
      }
  
      // SECURITY GUARD SPECIFIC LOGIC
      if (role === "Security Guard") {
        // ENTRY LOGIC
        if (eventType === "Start") {
          const twelveHoursAgo = new Date();
          twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
  
          // Check for recent entries
          const recentVehicle = await Vehicle.findOne({
            vehicleNumber: formattedVehicleNumber,
            entryTime: { $gte: twelveHoursAgo },
            exitTime: null,
          });
  
          if (recentVehicle) {
            // Close all previous open entries
            await Vehicle.updateMany(
              { vehicleNumber: formattedVehicleNumber, exitTime: null },
              { $set: { exitTime: new Date() } }
            );
            console.log(`🔹 Closed previous open entries for ${formattedVehicleNumber}`);
          }
  
          // Create new entry
          const newVehicle = new Vehicle({
            vehicleNumber: formattedVehicleNumber,
            entryTime: new Date(),
            exitTime: null,
            stages: [{
              stageName,
              role,
              eventType,
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              inKM: inKM || null,
              outKM: null,
              inDriver: inDriver || null,
              outDriver: null
            }]
          });
  
          await newVehicle.save();
          return res.status(201).json({
            success: true,
            message: "New vehicle entry recorded",
            vehicle: newVehicle
          });
        }
  
        // EXIT LOGIC
        if (eventType === "End") {
          if (!vehicle) {
            return res.status(400).json({
              success: false,
              message: "No active vehicle entry found to close"
            });
          }
  
          // Update the vehicle exit
          vehicle.exitTime = new Date();
          vehicle.stages.push({
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            },
            inKM: null,
            outKM: outKM || null,
            inDriver: null,
            outDriver: outDriver || null
          });
  
          await vehicle.save();
          return res.status(200).json({
            success: true,
            message: "Vehicle exit recorded",
            vehicle
          });
        }
      }
  
      // FOR OTHER ROLES - ALLOW NEW ENTRY IF VEHICLE DOESN'T EXIST
      if (!vehicle && eventType === "Start") {
        // Create new entry for non-security roles
        const newVehicle = new Vehicle({
          vehicleNumber: formattedVehicleNumber,
          entryTime: new Date(),
          exitTime: null,
          stages: [{
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            },
            workType: role === "Bay Technician" ? workType || null : null,
            bayNumber: role === "Bay Technician" ? bayNumber || null : null
          }]
        });
  
        await newVehicle.save();
        return res.status(201).json({
          success: true,
          message: "New vehicle entry recorded",
          vehicle: newVehicle
        });
      } else if (!vehicle && eventType !== "Start") {
        return res.status(400).json({
          success: false,
          message: "No active vehicle entry found. Please start a new entry first."
        });
      }
  
      // BAY WORK SPECIFIC LOGIC
      if (stageName.startsWith("Bay Work")) {
        const bayWorkStages = vehicle.stages.filter(stage =>
          stage.stageName.startsWith("Bay Work")
        );
      
        const bayNum = isNaN(bayNumber) ? bayNumber : Number(bayNumber);
      
        if (eventType === "Start") {
          const bayWorkCount = bayWorkStages.filter(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "Start"
          ).length;
      
          const unfinishedSameBayWork = bayWorkStages.find(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "Start" &&
            !bayWorkStages.some(s =>
              s.workType === workType &&
              s.bayNumber == bayNum &&
              s.eventType === "End" &&
              s.timestamp > stage.timestamp
            )
          );
      
          if (unfinishedSameBayWork) {
            return res.status(400).json({
              success: false,
              message: `Please end the previous ${workType} work in bay ${bayNum} first`
            });
          }
      
          const unfinishedAnyWork = bayWorkStages.find(stage =>
            stage.eventType === "Start" &&
            !bayWorkStages.some(s =>
              s.eventType === "End" &&
              s.timestamp > stage.timestamp
            )
          );
      
          if (unfinishedAnyWork) {
            vehicle.stages.push({
              stageName: unfinishedAnyWork.stageName,
              role: unfinishedAnyWork.role,
              eventType: "End",
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              workType: null,
              bayNumber: null,
              autoClosed: true
            });
            console.log(`⚠️ Auto-closed previous unfinished Bay Work: ${unfinishedAnyWork.stageName}`);
          }
      
          stageName = `Bay Work: ${workType}: ${bayWorkCount + 1}`;
        }
      
        if (["Pause", "Resume", "End"].includes(eventType)) {
          const lastStart = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Start" &&
              stage.stageName.startsWith("Bay Work")
            )
            .sort((a, b) => b.timestamp - a.timestamp)[0];
      
          if (!lastStart) {
            return res.status(400).json({
              success: false,
              message: `Cannot ${eventType.toLowerCase()} - no active ${workType} work in bay ${bayNum}`
            });
          }
      
          const hasEnded = bayWorkStages.some(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "End" &&
            stage.timestamp > lastStart.timestamp
          );
      
          if (hasEnded) {
            return res.status(400).json({
              success: false,
              message: `Cannot ${eventType.toLowerCase()} - work has already ended`
            });
          }
      
          const pauses = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Pause" &&
              stage.timestamp > lastStart.timestamp
            )
            .sort((a, b) => b.timestamp - a.timestamp);
      
          const resumes = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Resume" &&
              stage.timestamp > lastStart.timestamp
            )
            .sort((a, b) => b.timestamp - a.timestamp);
      
          if (eventType === "Pause" && pauses.length > resumes.length) {
            return res.status(400).json({
              success: false,
              message: "Work is already paused"
            });
          }
      
          if (eventType === "Resume" && (pauses.length === 0 || resumes.length >= pauses.length)) {
            return res.status(400).json({
              success: false,
              message: "Work is not paused"
            });
          }
      
          if (eventType === "End" && pauses.length > resumes.length) {
            return res.status(400).json({
              success: false,
              message: "Cannot end while work is paused - please resume first"
            });
          }
        }
      }
  
      // PREVENT DUPLICATE STAGE STARTS
      if (eventType === "Start") {
        const existingStage = vehicle.stages.find(stage => 
          stage.stageName === stageName && stage.eventType === "Start"
        );
        
        if (existingStage && !vehicle.stages.some(stage => 
          stage.stageName === stageName && stage.eventType === "End"
        )) {
          return res.status(400).json({
            success: false,
            message: `${stageName} has already been started and can only be started once.`
          });
        }
      }
  
      // SERVICE ADVISOR LOGIC
      if (role === "Service Advisor") {
        if (stageName === "Additional Work Job Approval" && eventType === "Start") {
          const additionalWorkCount = vehicle.stages.filter(stage => 
            stage.stageName.startsWith("Additional Work Job Approval") && stage.eventType === "Start"
          ).length;
          stageName = `Additional Work Job Approval ${additionalWorkCount + 1}`;
        }
  
        if (stageName === "Ready for Washing" && eventType === "Start") {
          const hasJobCardCreation = vehicle.stages.some(stage => 
            stage.stageName === "Job Card Creation + Customer Approval" && stage.eventType === "Start"
          );
          
          if (!hasJobCardCreation) {
            console.log(`⚠️ Alert: ${formattedVehicleNumber} attempted Ready for Washing without Job Card Creation`);
            const warningMessage = `Warning: You should have started Job Card Creation + Customer Approval first. Alert has been sent to admin.`;
            
            vehicle.stages.push({
              stageName,
              role,
              eventType,
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              warning: warningMessage
            });
            
            await vehicle.save();
            return res.status(200).json({
              success: true,
              message: warningMessage,
              vehicle
            });
          }
  
          const existingWashingStage = vehicle.stages.find(stage => 
            stage.stageName === "Ready for Washing" && stage.eventType === "Start"
          );
          
          if (existingWashingStage && !vehicle.stages.some(stage => 
            stage.stageName === "Ready for Washing" && stage.eventType === "End"
          )) {
            return res.status(400).json({
              success: false,
              message: "Ready for Washing has already been started and not yet ended."
            });
          }
        }
      }
    } catch (error) {
      console.error("Error in vehicle-check route:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message
      });
    }
  });




  router.post("/vehicle-check", authMiddleware, async (req, res) => {
    console.log("🔹 Incoming Request Data:", req.body);
  
    try {
      let {
        vehicleNumber,
        role,
        stageName,
        eventType,
        inKM,
        outKM,
        inDriver,
        outDriver,
        workType,
        bayNumber,
      } = req.body;
  
      // Validate required fields
      if (!vehicleNumber || !stageName || !eventType) {
        console.log("❌ Missing required fields");
        return res.status(400).json({
          success: false,
          message: "Vehicle number, stage name and event type are required."
        });
      }
  
      // Validate user role matches the role in request
      if (req.user.role !== role) {
        return res.status(403).json({
          success: false,
          message: "Your user role doesn't match the requested action role"
        });
      }
  
      const formattedVehicleNumber = vehicleNumber.trim().toUpperCase();
  
      // Find the most recent active vehicle entry
      let vehicle = await Vehicle.findOne({
        vehicleNumber: formattedVehicleNumber,
        exitTime: null
      }).sort({ entryTime: -1 });
  
      // N-1 CALLING LOGIC - MUST BE PLACED BEFORE THE NEW VEHICLE ENTRY LOGIC
      if (role === "Service Advisor" && stageName === "N-1 Calling" && eventType === "Start") {
        if (!vehicle) {
            // If vehicle doesn't exist, create a new vehicle object
            vehicle = new Vehicle({
                vehicleNumber: formattedVehicleNumber,
                stages: [], // Initialize stages array
            });
        }
          // Check if N-1 Calling has already been started
          const alreadyCalled = vehicle?.stages?.some(stage =>  // Use optional chaining
            stage.stageName === "N-1 Calling" && stage.eventType === "Start"
          ) || false; // Default to false if vehicle or stages are null
    
          if (alreadyCalled) {
            return res.status(400).json({
              success: false,
              message: "N-1 Calling has already been started for this vehicle."
            });
          }
        
          // Generate tracking token if it doesn't already exist
          if (!vehicle.trackingToken) {  // Use optional chaining
            vehicle.trackingToken = crypto.randomBytes(16).toString('hex'); // Generates a unique token
            console.log("Generated tracking token: ", vehicle.trackingToken);
          } else {
            console.log("Existing tracking token: ", vehicle.trackingToken);
          }
    
          // Add the new stage to the vehicle's stages
          const newStage = {
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            }
          };
    
          // Push the new stage into the existing stages or initialize if stages is null
          vehicle.stages = vehicle.stages ? [...vehicle.stages, newStage] : [newStage];
        
          try {
            await vehicle.save();
          } catch (error) {
            console.error("Error saving vehicle:", error);
            return res.status(500).json({
              success: false,
              message: "Error saving vehicle",
              error: error
            });
          }
    
          // Generate the tracking link using vehicle's trackingToken
          const vehicleLink = `https://SilverStar.com/track/${vehicle.trackingToken}`;
          console.log("Generated vehicle link: ", vehicleLink);
    
          return res.status(200).json({
            success: true,
            message: "N-1 Calling recorded successfully",
            trackingLink: vehicleLink,
            vehicle: {
              ...vehicle.toObject(), // Convert to plain JS object
              stages: [newStage] // Only send the new stage
            }
          });
      }
  
      // SECURITY GUARD SPECIFIC LOGIC
      if (role === "Security Guard") {
        // ENTRY LOGIC
        if (eventType === "Start") {
          const twelveHoursAgo = new Date();
          twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
  
          // Check for recent entries
          const recentVehicle = await Vehicle.findOne({
            vehicleNumber: formattedVehicleNumber,
            entryTime: { $gte: twelveHoursAgo },
            exitTime: null,
          });
  
          if (recentVehicle) {
            // Close all previous open entries
            await Vehicle.updateMany(
              { vehicleNumber: formattedVehicleNumber, exitTime: null },
              { $set: { exitTime: new Date() } }
            );
            console.log(`🔹 Closed previous open entries for ${formattedVehicleNumber}`);
          }
  
          // Create new entry
          const newVehicle = new Vehicle({
            vehicleNumber: formattedVehicleNumber,
            entryTime: new Date(),
            exitTime: null,
            stages: [{
              stageName,
              role,
              eventType,
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              inKM: inKM || null,
              outKM: null,
              inDriver: inDriver || null,
              outDriver: null
            }]
          });
  
          await newVehicle.save();
          return res.status(201).json({
            success: true,
            message: "New vehicle entry recorded",
            vehicle: newVehicle
          });
        }
  
        // EXIT LOGIC
        if (eventType === "End") {
          if (!vehicle) {
            return res.status(400).json({
              success: false,
              message: "No active vehicle entry found to close"
            });
          }
  
          // Update the vehicle exit
          vehicle.exitTime = new Date();
          vehicle.stages.push({
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            },
            inKM: null,
            outKM: outKM || null,
            inDriver: null,
            outDriver: outDriver || null
          });
  
          await vehicle.save();
          return res.status(200).json({
            success: true,
            message: "Vehicle exit recorded",
            vehicle
          });
        }
      }
  
      // FOR OTHER ROLES - ALLOW NEW ENTRY IF VEHICLE DOESN'T EXIST
      if (!vehicle && eventType === "Start") {
        // Create new entry for non-security roles
        const newVehicle = new Vehicle({
          vehicleNumber: formattedVehicleNumber,
          entryTime: new Date(),
          exitTime: null,
          stages: [{
            stageName,
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            },
            workType: role === "Bay Technician" ? workType || null : null,
            bayNumber: role === "Bay Technician" ? bayNumber || null : null
          }]
        });
  
        await newVehicle.save();
        return res.status(201).json({
          success: true,
          message: "New vehicle entry recorded",
          vehicle: newVehicle
        });
      } else if (!vehicle && eventType !== "Start") {
        return res.status(400).json({
          success: false,
          message: "No active vehicle entry found. Please start a new entry first."
        });
      }
  
      // BAY WORK SPECIFIC LOGIC
      if (stageName.startsWith("Bay Work")) {
        const bayWorkStages = vehicle.stages.filter(stage =>
          stage.stageName.startsWith("Bay Work")
        );
      
        const bayNum = isNaN(bayNumber) ? bayNumber : Number(bayNumber);
      
        if (eventType === "Start") {
          const bayWorkCount = bayWorkStages.filter(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "Start"
          ).length;
      
          const unfinishedSameBayWork = bayWorkStages.find(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "Start" &&
            !bayWorkStages.some(s =>
              s.workType === workType &&
              s.bayNumber == bayNum &&
              s.eventType === "End" &&
              s.timestamp > stage.timestamp
            )
          );
      
          if (unfinishedSameBayWork) {
            return res.status(400).json({
              success: false,
              message: `Please end the previous ${workType} work in bay ${bayNum} first`
            });
          }
      
          const unfinishedAnyWork = bayWorkStages.find(stage =>
            stage.eventType === "Start" &&
            !bayWorkStages.some(s =>
              s.eventType === "End" &&
              s.timestamp > stage.timestamp
            )
          );
      
          if (unfinishedAnyWork) {
            vehicle.stages.push({
              stageName: unfinishedAnyWork.stageName,
              role: unfinishedAnyWork.role,
              eventType: "End",
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              workType: null,
              bayNumber: null,
              autoClosed: true
            });
            console.log(`⚠️ Auto-closed previous unfinished Bay Work: ${unfinishedAnyWork.stageName}`);
          }
      
          stageName = `Bay Work: ${workType}: ${bayWorkCount + 1}`;
        }
      
        if (["Pause", "Resume", "End"].includes(eventType)) {
          const lastStart = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Start" &&
              stage.stageName.startsWith("Bay Work")
            )
            .sort((a, b) => b.timestamp - a.timestamp)[0];
      
          if (!lastStart) {
            return res.status(400).json({
              success: false,
              message: `Cannot ${eventType.toLowerCase()} - no active ${workType} work in bay ${bayNum}`
            });
          }
      
          const hasEnded = bayWorkStages.some(stage =>
            stage.workType === workType &&
            stage.bayNumber == bayNum &&
            stage.eventType === "End" &&
            stage.timestamp > lastStart.timestamp
          );
      
          if (hasEnded) {
            return res.status(400).json({
              success: false,
              message: `Cannot ${eventType.toLowerCase()} - work has already ended`
            });
          }
      
          const pauses = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Pause" &&
              stage.timestamp > lastStart.timestamp
            )
            .sort((a, b) => b.timestamp - a.timestamp);
      
          const resumes = bayWorkStages
            .filter(stage =>
              stage.workType === workType &&
              stage.bayNumber == bayNum &&
              stage.eventType === "Resume" &&
              stage.timestamp > lastStart.timestamp
            )
            .sort((a, b) => b.timestamp - a.timestamp);
      
          if (eventType === "Pause" && pauses.length > resumes.length) {
            return res.status(400).json({
              success: false,
              message: "Work is already paused"
            });
          }
      
          if (eventType === "Resume" && (pauses.length === 0 || resumes.length >= pauses.length)) {
            return res.status(400).json({
              success: false,
              message: "Work is not paused"
            });
          }
      
          if (eventType === "End" && pauses.length > resumes.length) {
            return res.status(400).json({
              success: false,
              message: "Cannot end while work is paused - please resume first"
            });
          }
        }
      }
  
      // PREVENT DUPLICATE STAGE STARTS
      if (eventType === "Start") {
        const existingStage = vehicle.stages.find(stage => 
          stage.stageName === stageName && stage.eventType === "Start"
        );
        
        if (existingStage && !vehicle.stages.some(stage => 
          stage.stageName === stageName && stage.eventType === "End"
        )) {
          return res.status(400).json({
            success: false,
            message: `${stageName} has already been started and can only be started once.`
          });
        }
      }
  
      // SERVICE ADVISOR LOGIC
      if (role === "Service Advisor") {
        if (stageName === "Additional Work Job Approval" && eventType === "Start") {
          const additionalWorkCount = vehicle.stages.filter(stage => 
            stage.stageName.startsWith("Additional Work Job Approval") && stage.eventType === "Start"
          ).length;
          stageName = `Additional Work Job Approval ${additionalWorkCount + 1}`;
        }
  
        if (stageName === "Ready for Washing" && eventType === "Start") {
          const hasJobCardCreation = vehicle.stages.some(stage => 
            stage.stageName === "Job Card Creation + Customer Approval" && stage.eventType === "Start"
          );
          
          if (!hasJobCardCreation) {
            console.log(`⚠️ Alert: ${formattedVehicleNumber} attempted Ready for Washing without Job Card Creation`);
            const warningMessage = `Warning: You should have started Job Card Creation + Customer Approval first. Alert has been sent to admin.`;
            
            vehicle.stages.push({
              stageName,
              role,
              eventType,
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              warning: warningMessage
            });
            
            await vehicle.save();
            return res.status(200).json({
              success: true,
              message: warningMessage,
              vehicle
            });
          }
  
          const existingWashingStage = vehicle.stages.find(stage => 
            stage.stageName === "Ready for Washing" && stage.eventType === "Start"
          );
          
          if (existingWashingStage && !vehicle.stages.some(stage => 
            stage.stageName === "Ready for Washing" && stage.eventType === "End"
          )) {
            return res.status(400).json({
              success: false,
              message: "Ready for Washing has already been started and not yet ended."
            });
          }
        }
      }
    } catch (error) {
      console.error("Error in vehicle-check route:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message
      });
    }
  });
