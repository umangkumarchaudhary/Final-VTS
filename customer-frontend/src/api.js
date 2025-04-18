import axios from 'axios';

const BASE_URL = 'http://localhost:5000/api';

export const fetchVehicleStatus = async (trackingId) => {
  try {
    const res = await axios.get(`${BASE_URL}/public/track/${trackingId}`);
    return res.data;
  } catch (err) {
    throw err.response?.data || { message: 'Something went wrong' };
  }
};
