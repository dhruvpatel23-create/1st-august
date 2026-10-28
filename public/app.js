// ============ FindMyDevice Client ============

(function () {
  'use strict';

  // --- DOM References ---
  const screens = {
    landing: document.getElementById('screen-landing'),
    join: document.getElementById('screen-join'),
    waiting: document.getElementById('screen-waiting'),
    tracking: document.getElementById('screen-tracking'),
  };

  const els = {
    btnCreate: document.getElementById('btn-create'),
    btnJoin: document.getElementById('btn-join'),
    btnBackJoin: document.getElementById('btn-back-join'),
    btnConnect: document.getElementById('btn-connect'),
    btnCopyCode: document.getElementById('btn-copy-code'),
    btnDisconnect: document.getElementById('btn-disconnect'),
    inputCode: document.getElementById('input-code'),
    joinError: document.getElementById('join-error'),
    displayCode: document.getElementById('display-code'),
    gpsStatusWaiting: document.getElementById('gps-status-waiting'),
    trackingSessionId: document.getElementById('tracking-session-id'),
    roleBadge: document.getElementById('role-badge'),
    distanceValue: document.getElementById('distance-value'),
    distanceUnit: document.getElementById('distance-unit'),
    otherMarker: document.getElementById('other-marker'),
    otherLabel: document.getElementById('other-label'),
    compassArrow: document.getElementById('compass-arrow'),
    bearingValue: document.getElementById('bearing-value'),
    statusA: document.getElementById('status-a'),
    statusB: document.getElementById('status-b'),
    coordsA: document.getElementById('coords-a'),
    coordsB: document.getElementById('coords-b'),
    accuracyA: document.getElementById('accuracy-a'),
    accuracyB: document.getElementById('accuracy-b'),
    signalBars: document.getElementById('signal-bars'),
    signalLabel: document.getElementById('signal-label'),
  };

  // --- State ---
  let socket = null;
  let myRole = null; // 'A' or 'B'
  let sessionId = null;
  let geoWatchId = null;
  let currentDistance = null;

  // --- Socket Connection ---
  function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      showToast('Connection lost. Reconnecting...', 'error');
    });

    socket.on('device-joined', (data) => {
      showToast('Device B has joined! 🎉');
      showScreen('tracking');
      startTracking();
    });

    socket.on('device-disconnected', (data) => {
      showToast(`Device ${data.device} disconnected`, 'error');
      if (data.device === 'A') {
        // Session owner left, go back to landing
        stopTracking();
        showScreen('landing');
      }
    });

    socket.on('location-update', (data) => {
      updateTrackingUI(data);
    });
  }

  // --- Screen Navigation ---
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // --- GPS ---
  function startGPS(callback) {
    if (!navigator.geolocation) {
      showToast('Geolocation is not supported by your browser', 'error');
      return;
    }

    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        callback({ lat: latitude, lng: longitude, accuracy });
      },
      (err) => {
        console.error('GPS Error:', err);
        let msg = 'GPS error';
        switch (err.code) {
          case 1: msg = 'Location permission denied. Please enable GPS.'; break;
          case 2: msg = 'Position unavailable.'; break;
          case 3: msg = 'GPS timeout. Retrying...'; break;
        }
        showToast(msg, 'error');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 10000,
      }
    );
  }

  function stopGPS() {
    if (geoWatchId !== null) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
  }

  // --- Create Session (Device A) ---
  function createSession() {
    myRole = 'A';
    socket.emit('create-session', (response) => {
      if (response.success) {
        sessionId = response.sessionId;
        els.displayCode.textContent = sessionId;
        showScreen('waiting');

        // Start GPS immediately
        startGPS((loc) => {
          socket.emit('location-update', loc);
          // Update waiting screen GPS status
          const statusEl = els.gpsStatusWaiting;
          statusEl.innerHTML = `<span class="status-dot active"></span><span>GPS Active — Accuracy: ${Math.round(loc.accuracy)}m</span>`;
        });
      } else {
        showToast('Failed to create session', 'error');
      }
    });
  }

  // --- Join Session (Device B) ---
  function joinSession() {
    const code = els.inputCode.value.trim().toUpperCase();
    if (code.length !== 6) return;

    myRole = 'B';
    els.joinError.classList.add('hidden');

    socket.emit('join-session', code, (response) => {
      if (response.success) {
        sessionId = response.sessionId;
        showScreen('tracking');
        startTracking();
      } else {
        els.joinError.textContent = response.error;
        els.joinError.classList.remove('hidden');
      }
    });
  }

  // --- Start Tracking ---
  function startTracking() {
    els.trackingSessionId.textContent = sessionId;
    els.roleBadge.textContent = myRole;
    els.otherLabel.textContent = myRole === 'A' ? 'Device B' : 'Device A';

    // Start GPS for tracking
    startGPS((loc) => {
      socket.emit('location-update', loc);
    });
  }

  function stopTracking() {
    stopGPS();
    sessionId = null;
    myRole = null;
    currentDistance = null;
  }

  // --- Update Tracking UI ---
  function updateTrackingUI(data) {
    // Update coordinates
    if (data.deviceA) {
      if (data.deviceA.lat !== null) {
        els.coordsA.textContent = `${data.deviceA.lat.toFixed(6)}, ${data.deviceA.lng.toFixed(6)}`;
        els.accuracyA.textContent = `±${Math.round(data.deviceA.accuracy)}m accuracy`;
        els.statusA.textContent = 'Online';
        els.statusA.classList.add('online');
      }
    }

    if (data.deviceB) {
      if (data.deviceB.lat !== null) {
        els.coordsB.textContent = `${data.deviceB.lat.toFixed(6)}, ${data.deviceB.lng.toFixed(6)}`;
        els.accuracyB.textContent = `±${Math.round(data.deviceB.accuracy)}m accuracy`;
        els.statusB.textContent = 'Online';
        els.statusB.classList.add('online');
      }
    }

    // Update distance
    if (data.distance !== null && data.distance !== undefined) {
      currentDistance = data.distance;
      updateDistanceDisplay(data.distance);
      updateRadarPosition(data.distance, data.bearing);
      updateCompass(data.bearing);
      updateSignalBars(data.distance);
    }
  }

  function updateDistanceDisplay(meters) {
    const distEl = els.distanceValue;
    let value, unit, colorClass;

    if (meters < 1) {
      value = (meters * 100).toFixed(0);
      unit = 'centimeters';
      colorClass = 'near';
    } else if (meters < 100) {
      value = meters.toFixed(1);
      unit = 'meters';
      colorClass = 'near';
    } else if (meters < 1000) {
      value = meters.toFixed(0);
      unit = 'meters';
      colorClass = 'mid';
    } else if (meters < 10000) {
      value = (meters / 1000).toFixed(2);
      unit = 'kilometers';
      colorClass = 'far';
    } else {
      value = (meters / 1000).toFixed(1);
      unit = 'kilometers';
      colorClass = 'very-far';
    }

    distEl.textContent = value;
    distEl.className = 'distance-value ' + colorClass;
    els.distanceUnit.textContent = unit;
  }

  function updateRadarPosition(distance, bearing) {
    const marker = els.otherMarker;
    const radarRadius = 90; // half of 200px container minus padding

    // Map distance to radar position (closer = center, farther = edge)
    let normalizedDist;
    if (distance < 10) normalizedDist = 0.1;
    else if (distance < 50) normalizedDist = 0.25;
    else if (distance < 200) normalizedDist = 0.45;
    else if (distance < 1000) normalizedDist = 0.65;
    else if (distance < 5000) normalizedDist = 0.8;
    else normalizedDist = 0.95;

    const rad = ((bearing || 0) - 90) * (Math.PI / 180);
    const x = Math.cos(rad) * radarRadius * normalizedDist;
    const y = Math.sin(rad) * radarRadius * normalizedDist;

    marker.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  function updateCompass(bearing) {
    if (bearing === null || bearing === undefined) return;
    els.compassArrow.style.transform = `rotate(${bearing}deg)`;
    els.bearingValue.textContent = `${Math.round(bearing)}°`;
  }

  function updateSignalBars(distance) {
    const bars = els.signalBars.querySelectorAll('.bar');
    let activeBars = 0;
    let label = '';
    let barClass = 'active';

    if (distance < 10) {
      activeBars = 5; label = 'Very Close'; barClass = 'active';
    } else if (distance < 50) {
      activeBars = 4; label = 'Close'; barClass = 'active';
    } else if (distance < 200) {
      activeBars = 3; label = 'Nearby'; barClass = 'active';
    } else if (distance < 1000) {
      activeBars = 2; label = 'Moderate'; barClass = 'active warn';
    } else if (distance < 5000) {
      activeBars = 1; label = 'Far'; barClass = 'active bad';
    } else {
      activeBars = 0; label = 'Very Far';
    }

    bars.forEach((bar, i) => {
      bar.className = 'bar b' + (i + 1);
      if (i < activeBars) {
        bar.classList.add(...barClass.split(' '));
      }
    });

    els.signalLabel.textContent = label;
  }

  // --- Toast Notifications ---
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toast-out 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- Event Listeners ---
  els.btnCreate.addEventListener('click', createSession);

  els.btnJoin.addEventListener('click', () => {
    showScreen('join');
    setTimeout(() => els.inputCode.focus(), 400);
  });

  els.btnBackJoin.addEventListener('click', () => {
    showScreen('landing');
    els.inputCode.value = '';
    els.joinError.classList.add('hidden');
  });

  els.inputCode.addEventListener('input', () => {
    els.inputCode.value = els.inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    els.btnConnect.disabled = els.inputCode.value.length !== 6;
  });

  els.inputCode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && els.inputCode.value.length === 6) {
      joinSession();
    }
  });

  els.btnConnect.addEventListener('click', joinSession);

  els.btnCopyCode.addEventListener('click', () => {
    const code = els.displayCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
      showToast('Code copied to clipboard!', 'info');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Code copied!', 'info');
    });
  });

  els.btnDisconnect.addEventListener('click', () => {
    stopTracking();
    if (socket) socket.disconnect();
    showScreen('landing');
    // Reconnect socket for next session
    setTimeout(() => {
      socket.connect();
    }, 500);
  });

  // --- Initialize ---
  connectSocket();

})();
