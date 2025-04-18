import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import VehicleStatus from './components/VehicleStatus';

function App() {
  return (
    <Router>
      <Routes>
        {/* Home Route */}
        <Route path="/" element={<div>Welcome to SilverStar Vehicle Tracking</div>} />

        {/* Tracking Route */}
        <Route path="/track/:trackingId" element={<VehicleStatus />} />

        {/* 404 Fallback */}
        <Route path="*" element={<div>404 - Page Not Found</div>} />
      </Routes>
    </Router>
  );
}

export default App;
