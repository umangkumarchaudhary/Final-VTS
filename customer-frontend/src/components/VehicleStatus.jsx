import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchVehicleStatus } from '../api';
import './VehicleStatus.css';
import {
  FaPhone,
  FaEnvelope,
  FaWrench,
  FaClipboardList,
  FaPhoneVolume,
  FaCar,
  FaCheckCircle,
  FaUserTie,
  FaInfoCircle
} from 'react-icons/fa';
import { IoMdTime } from 'react-icons/io';

function VehicleStatus() {
  const { trackingId } = useParams();
  const [vehicle, setVehicle] = useState(null);
  const [error, setError] = useState('');
  const [expandedStage, setExpandedStage] = useState(null);

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const data = await fetchVehicleStatus(trackingId);
        setVehicle(data);

        // Auto-expand first active stage
        if (data?.stages?.length) {
          const grouped = groupStages(data.stages);
          const activeIndex = grouped.findIndex(g => g.isActive);
          setExpandedStage(activeIndex !== -1 ? activeIndex : 0);
        }
      } catch (err) {
        setError(err.message || 'Unable to fetch status');
      }
    };

    loadStatus();
  }, [trackingId]);

  const getStageIcon = (stageName) => {
    switch (stageName.toLowerCase()) {
      case 'job card creation': return <FaClipboardList className="stage-icon" />;
      case 'bay work': return <FaWrench className="stage-icon" />;
      case 'n-1 calling': return <FaPhoneVolume className="stage-icon" />;
      case 'vehicle delivery': return <FaCar className="stage-icon" />;
      case 'quality check': return <FaCheckCircle className="stage-icon" />;
      default: return <IoMdTime className="stage-icon" />;
    }
  };

  const groupStages = (stages) => {
    const map = {};

    stages.forEach(stage => {
      const key = stage.stageName;
      if (!map[key]) map[key] = {};
      map[key][stage.eventType.toLowerCase()] = stage;
    });

    return Object.entries(map).map(([stageName, events]) => {
      const start = events.start;
      const end = events.end;

      return {
        stageName,
        start,
        end,
        isActive: !!start && !end,
        isCompleted: !!start && !!end,
      };
    });
  };

  if (error) return <div className="error-box">{error}</div>;
  if (!vehicle) return <div className="loading-box">Loading...</div>;

  const groupedStages = groupStages(vehicle.stages);

  return (
    <div className="vehicle-status-container">
      <div className="header-section">
        <h1 className="app-header">Mercedes Benz Silver Star</h1>
        <div className="vehicle-number">{vehicle.vehicleNumber}</div>
      </div>

      <div className="content-grid">
        {/* Advisor Section */}
        {vehicle.dedicatedAdvisor && (
          <div className="advisor-container">
            <h3><FaUserTie className="icon" /> Service Advisor</h3>
            <div className="advisor-details">
              <p><strong>Name:</strong> {vehicle.dedicatedAdvisor.name || 'Not specified'}</p>
              <p><FaPhone className="icon" /> {vehicle.dedicatedAdvisor.mobile || 'Not specified'}</p>
              <p><FaEnvelope className="icon" /> {vehicle.dedicatedAdvisor.email || 'Not specified'}</p>
            </div>
          </div>
        )}

        {/* Compact Timeline */}
        <div className="compact-timeline">
          <h3><FaInfoCircle className="icon" /> Service Progress</h3>
          <div className="stages-grid">
            {groupedStages.map((stage, index) => {
              const { stageName, start, end, isActive, isCompleted } = stage;

              return (
                <div
                  key={index}
                  className={`stage-card ${expandedStage === index ? 'expanded' : ''}`}
                  onClick={() => setExpandedStage(index === expandedStage ? null : index)}
                >
                  <div className="stage-header">
                    {getStageIcon(stageName)}
                    <div>
                      <h4>{stageName}</h4>
                      <p className="stage-time">
                        {start && `Start: ${new Date(start.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                        {end && ` | End: ${new Date(end.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                      </p>
                    </div>
                    <span className={`status-badge ${isActive ? 'active' : isCompleted ? 'completed' : 'pending'}`}>
                      {isCompleted ? 'Completed' : isActive ? 'In Progress' : 'Pending'}
                    </span>
                  </div>

                  {expandedStage === index && (
                    <div className="stage-details">
                      {start?.comments && <p><strong>Start Note:</strong> {start.comments}</p>}
                      {end?.comments && <p><strong>End Note:</strong> {end.comments}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default VehicleStatus;
