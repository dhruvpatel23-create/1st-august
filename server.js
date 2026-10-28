const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Store active tracking sessions
// Each session has: { id, deviceA: { socketId, lat, lng, lastUpdate }, deviceB: { ... } }
const sessions = new Map();

io.on('connection', (socket) => {
  console.log(`[+] Device connected: ${socket.id}`);

  // Create a new tracking session (Device A)
  socket.on('create-session', (callback) => {
    // Generate a short 6-char room code
    const sessionId = generateCode();
    sessions.set(sessionId, {
      id: sessionId,
      deviceA: { socketId: socket.id, lat: null, lng: null, accuracy: null, lastUpdate: null },
      deviceB: null,
      createdAt: Date.now()
    });
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.deviceRole = 'A';
    console.log(`[Session] Created: ${sessionId} by ${socket.id}`);
    callback({ success: true, sessionId });
  });

  // Join an existing session (Device B)
  socket.on('join-session', (sessionId, callback) => {
    const session = sessions.get(sessionId.toUpperCase());
    if (!session) {
      return callback({ success: false, error: 'Session not found. Check the code and try again.' });
    }
    if (session.deviceB && session.deviceB.socketId) {
      // Check if device B is still connected
      const existingSocket = io.sockets.sockets.get(session.deviceB.socketId);
      if (existingSocket) {
        return callback({ success: false, error: 'Session already has two devices connected.' });
      }
    }
    session.deviceB = { socketId: socket.id, lat: null, lng: null, accuracy: null, lastUpdate: null };
    socket.join(sessionId.toUpperCase());
    socket.sessionId = sessionId.toUpperCase();
    socket.deviceRole = 'B';

    // Notify Device A that Device B joined
    io.to(session.deviceA.socketId).emit('device-joined', { device: 'B' });

    console.log(`[Session] ${socket.id} joined ${sessionId} as Device B`);
    callback({ success: true, sessionId: sessionId.toUpperCase() });

    // If Device A already has location, send it to B
    if (session.deviceA.lat !== null) {
      socket.emit('location-update', {
        device: 'A',
        lat: session.deviceA.lat,
        lng: session.deviceA.lng,
        accuracy: session.deviceA.accuracy,
        distance: null
      });
    }
  });

  // Handle location updates
  socket.on('location-update', (data) => {
    const session = sessions.get(socket.sessionId);
    if (!session) return;

    const role = socket.deviceRole;
    const deviceKey = role === 'A' ? 'deviceA' : 'deviceB';

    // Update stored location
    session[deviceKey].lat = data.lat;
    session[deviceKey].lng = data.lng;
    session[deviceKey].accuracy = data.accuracy;
    session[deviceKey].lastUpdate = Date.now();

    // Calculate distance if both devices have locations
    let distance = null;
    let bearing = null;
    if (session.deviceA.lat !== null && session.deviceB && session.deviceB.lat !== null) {
      distance = haversineDistance(
        session.deviceA.lat, session.deviceA.lng,
        session.deviceB.lat, session.deviceB.lng
      );
      bearing = calculateBearing(
        session.deviceA.lat, session.deviceA.lng,
        session.deviceB.lat, session.deviceB.lng
      );
    }

    // Broadcast to all devices in session
    io.to(socket.sessionId).emit('location-update', {
      device: role,
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
      distance,
      bearing,
      deviceA: { lat: session.deviceA.lat, lng: session.deviceA.lng, accuracy: session.deviceA.accuracy },
      deviceB: session.deviceB ? { lat: session.deviceB.lat, lng: session.deviceB.lng, accuracy: session.deviceB.accuracy } : null
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`[-] Device disconnected: ${socket.id}`);
    if (socket.sessionId) {
      const session = sessions.get(socket.sessionId);
      if (session) {
        const role = socket.deviceRole;
        io.to(socket.sessionId).emit('device-disconnected', { device: role });

        // If Device A disconnects, destroy the session
        if (role === 'A') {
          sessions.delete(socket.sessionId);
          console.log(`[Session] Destroyed: ${socket.sessionId}`);
        } else {
          // Device B disconnected, clear its data
          session.deviceB = null;
        }
      }
    }
  });
});

// --- Utility Functions ---

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure uniqueness
  if (sessions.has(code)) return generateCode();
  return code;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in meters
}

function calculateBearing(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Clean up stale sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 3600000) { // 1 hour
      sessions.delete(id);
      console.log(`[Cleanup] Removed stale session: ${id}`);
    }
  }
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🔍 FindMyDevice server running at:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-ip>:${PORT}\n`);
});
