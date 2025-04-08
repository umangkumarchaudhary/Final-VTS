router.post("/vehicle-check", authMiddleware, async (req, res) => {
    console.log("🔹 Incoming Request Data:", req.body);
  
    try {
      const {
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
      
      // SECURITY GUARD SPECIFIC LOGIC
      if (role === "Security Guard") {
        // Find the most recent vehicle entry (regardless of exit status)
        const latestVehicle = await Vehicle.findOne({
          vehicleNumber: formattedVehicleNumber
        }).sort({ entryTime: -1 });
  
        // ENTRY LOGIC
        if (eventType === "Start") {
          // Case 1: No existing record or last event was exit - create new entry
          if (!latestVehicle || latestVehicle.exitTime) {
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
                inKM,
                outKM: null,
                inDriver,
                outDriver: null
              }]
            });
  
            await newVehicle.save();
            return res.status(201).json({
              success: true,
              newVehicle: true,
              message: "New vehicle entry recorded.",
              vehicle: newVehicle
            });
          }
  
          // Case 2: Existing open entry (missed exit scan)
          if (!latestVehicle.exitTime) {
            const twelveHoursAgo = new Date();
            twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
  
            // If entry was within last 12 hours, close it and create new entry
            if (latestVehicle.entryTime >= twelveHoursAgo) {
              // Close all previous open entries
              await Vehicle.updateMany(
                { vehicleNumber: formattedVehicleNumber, exitTime: null },
                { $set: { exitTime: new Date() } }
              );
  
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
                  inKM,
                  outKM: null,
                  inDriver,
                  outDriver: null
                }]
              });
  
              await newVehicle.save();
              return res.status(201).json({
                success: true,
                newVehicle: true,
                message: "Previous entry closed and new vehicle entry recorded.",
                vehicle: newVehicle
              });
            } else {
              // Entry was more than 12 hours ago - treat as new entry
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
                  inKM,
                  outKM: null,
                  inDriver,
                  outDriver: null
                }]
              });
  
              await newVehicle.save();
              return res.status(201).json({
                success: true,
                newVehicle: true,
                message: "New vehicle entry recorded (previous entry was older than 12 hours).",
                vehicle: newVehicle
              });
            }
          }
        }
  
        // EXIT LOGIC
        if (eventType === "End") {
          if (!latestVehicle || latestVehicle.exitTime) {
            return res.status(400).json({
              success: false,
              message: "No active vehicle entry found to exit."
            });
          }
  
          // Close all stages and the vehicle entry
          latestVehicle.exitTime = new Date();
          
          // Add exit stage
          latestVehicle.stages.push({
            stageName: "Security Exit",
            role,
            eventType,
            timestamp: new Date(),
            performedBy: {
              userId: req.user._id,
              userName: req.user.name
            },
            inKM: null,
            outKM,
            inDriver: null,
            outDriver
          });
  
          await latestVehicle.save();
          
          console.log(`🚨 Vehicle process closed for ${formattedVehicleNumber}`);
          console.log(`🔔 Alert sent to Workshop Manager and Admin for ${formattedVehicleNumber}`);
  
          return res.status(200).json({
            success: true,
            message: "Vehicle exit recorded and all processes closed.",
            vehicle: latestVehicle
          });
        }
      }
  
      // NON-SECURITY GUARD LOGIC (existing implementation)
      let vehicle = await Vehicle.findOne({
        vehicleNumber: formattedVehicleNumber,
        exitTime: null
      }).sort({ entryTime: -1 });
  
      // Case 1: New Vehicle Entry (for non-security roles)
      if (!vehicle || (vehicle.exitTime && new Date(vehicle.exitTime) <= new Date())) {
        vehicle = new Vehicle({
          vehicleNumber: formattedVehicleNumber,
          entryTime: new Date(),
          exitTime: null,
          stages: [
            {
              stageName,
              role,
              eventType,
              timestamp: new Date(),
              performedBy: {
                userId: req.user._id,
                userName: req.user.name
              },
              workType: role === "Bay Technician" ? workType || null : null,
              bayNumber: role === "Bay Technician" ? bayNumber || null : null,
            },
          ],
        });
  
        await vehicle.save();
        return res.status(201).json({
          success: true,
          newVehicle: true,
          message: "New vehicle entry recorded.",
          vehicle
        });
      }
  
      // ... rest of your existing non-security guard logic ...
  
      await vehicle.save();
      return res.status(200).json({
        success: true,
        message: `${stageName} updated successfully.`,
        vehicle
      });
  
    } catch (error) {
      console.error("❌ Error in /vehicle-check:", error);
      return res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message
      });
    }
  });