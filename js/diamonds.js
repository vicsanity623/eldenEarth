// ============================================================
// Elden Earth — diamonds (Mapbox GL JS 3D Native Engine)
// ============================================================
const Diamonds = (() => {
  let map = null;
  let markers = {};        // id -> Mapbox Marker
  let playerPos = null;    // {lat, lon}
  let onCollect = () => {};
  let onDenied = () => {};
  let spawnTimer = null;
  
  // Vector Tile Water Detection: Prevents diamonds from spawning in oceans, bays, or lakes
  function isPointInWater(lat, lon) {
    if (!map) return false;
    try {
      const pt = map.project([lon, lat]);
      // Query MapLibre's vector water layers at these screen coordinates
      const waterLayers = (map.getStyle().layers || [])
        .map(l => l.id)
        .filter(id => id.includes("water") || id.includes("ocean") || id.includes("lake"));

      if (waterLayers.length === 0) return false;
      const hits = map.queryRenderedFeatures(pt, { layers: waterLayers });
      return hits.length > 0;
    } catch (e) {
      return false;
    }
  }

  // Floating Combat Text Helper
  function spawnFloatingText(x, y, htmlContent) {
    const popup = document.createElement("div");
    popup.className = "combat-text-popup";
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    popup.innerHTML = htmlContent;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 2100);
  }

  // Flying 3D Gem Arc Particle to HUD
  function spawnFlyingGemToHUD(startX, startY) {
    const targetEl = document.getElementById("stat-diamonds");
    if (!targetEl) return;

    const targetBounds = targetEl.getBoundingClientRect();
    const endX = targetBounds.left + targetBounds.width / 2;
    const endY = targetBounds.top + targetBounds.height / 2;

    const gem = document.createElement("div");
    gem.className = "flying-3d-gem";
    gem.style.left = `${startX}px`;
    gem.style.top = `${startY}px`;
    gem.innerHTML = `
      <svg viewBox="0 0 32 38">
        <polygon points="16,2 29,12 16,16 3,12" fill="#a8f5ec"/>
        <polygon points="3,12 16,16 16,36" fill="#1d7a6e"/>
        <polygon points="29,12 16,16 16,36" fill="#4fd6c4"/>
        <polygon points="16,2 20,8 16,16 12,8" fill="#ffffff"/>
      </svg>
    `;
    document.body.appendChild(gem);

    requestAnimationFrame(() => {
      gem.style.transform = `translate(${endX - startX}px, ${endY - startY}px) scale(0.4) rotate(360deg)`;
      gem.style.opacity = "0.2";
    });

    setTimeout(() => {
      gem.remove();
      targetEl.classList.remove("hud-impact-bump");
      void targetEl.offsetWidth;
      targetEl.classList.add("hud-impact-bump");
    }, 750);
  }

  // Mini Particle Burst Explosion on Tap
  function triggerParticleExplosion(x, y) {
    const container = document.createElement("div");
    container.className = "gem-explosion-container";
    container.style.left = x + "px";
    container.style.top = y + "px";
    document.body.appendChild(container);

    for (let i = 0; i < 10; i++) {
      const p = document.createElement("span");
      p.className = "burst-spark";
      const angle = (i / 10) * 360 + (Math.random() * 20 - 10);
      const dist = 30 + Math.random() * 35;
      const rad = (angle * Math.PI) / 180;
      p.style.setProperty("--tx", `${Math.cos(rad) * dist}px`);
      p.style.setProperty("--ty", `${Math.sin(rad) * dist}px`);
      container.appendChild(p);
    }
    setTimeout(() => container.remove(), 700);
  }

  // Lightweight GPU-Accelerated 3D Gem (Zero Duplicate Shader Overhead)
  function createGemElement(dim, did) {
    const el = document.createElement("div");
    el.className = "diamond-3d-wrapper" + (dim ? " far" : "");

    const randomDuration = (2.8 + Math.random() * 0.8).toFixed(2) + "s";
    const randomDelay = (-Math.random() * 3.0).toFixed(2) + "s";

    el.innerHTML = `
      <div class="gem-anchor" style="--hover-dur:${randomDuration}; --hover-delay:${randomDelay};">
        <div class="gem-shadow"></div>
        <div class="gem-3d">
          <svg viewBox="0 0 32 38" class="gem-svg">
            <polygon points="16,2 29,12 16,16 3,12" fill="#a8f5ec"/>
            <polygon points="3,12 16,16 16,36" fill="#1d7a6e"/>
            <polygon points="29,12 16,16 16,36" fill="#4fd6c4"/>
            <polygon points="16,2 20,8 16,16 12,8" fill="rgba(255,255,255,0.85)"/>
          </svg>
          <div class="gem-sparkle-1">✦</div>
        </div>
      </div>
    `;

    el.addEventListener("click", (e) => {
      e.stopPropagation();
      attemptCollect(did);
    });
    return el;
  }

  function id() {
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function withinCollectRange(lat, lon) {
    if (!playerPos) return false;
    return Geo.haversine(playerPos.lat, playerPos.lon, lat, lon) <= CONFIG.DIAMOND_COLLECT_RADIUS_METERS;
  }

  function renderAll() {
    // Battery Saver: Skip marker rendering if phone is in pocket or map not loaded
    if (!map || document.hidden) return;
    const state = Store.get();
    const live = state.liveDiamonds;

    // Remove stale markers
    for (const mid in markers) {
      if (!live[mid]) {
        markers[mid].remove();
        delete markers[mid];
      }
    }

    // Add or update markers
    const collected = new Set(state.collectedDiamondIds || []);
    const bounds = map.getBounds(); // Get active screen viewport

    for (const did in live) {
      if (collected.has(did)) {
        delete live[did];
        continue;
      }
      const d = live[did];

      // Viewport Culling: Skip rendering if diamond is off-screen (Saves dozens of CSS loops!)
      if (bounds && !bounds.contains([d.lon, d.lat])) {
        if (markers[did]) { markers[did].remove(); delete markers[did]; }
        continue;
      }

      const dim = !withinCollectRange(d.lat, d.lon);

      if (markers[did]) {
        const el = markers[did].getElement();
        if (el) {
          if (dim) el.classList.add("far");
          else el.classList.remove("far");
        }
      } else {
        const el = createGemElement(dim, did);
        const m = new mapboxgl.Marker({
          element: el,
          pitchAlignment: "viewport",    // Stands vertically upright in 3D
          rotationAlignment: "viewport", // Faces player camera
        })
          .setLngLat([d.lon, d.lat])
          .addTo(map);

        markers[did] = m;
      }
    }
  }

  function attemptCollect(did) {
    const state = Store.get();
    const d = state.liveDiamonds[did];
    if (!d) return;

    if (!withinCollectRange(d.lat, d.lon)) {
      onDenied();
      return;
    }

    if (map) {
      const pt = map.project([d.lon, d.lat]);
      triggerParticleExplosion(pt.x, pt.y);
      spawnFloatingText(pt.x, pt.y - 20, `+1 <span class="hud-gem-icon"></span>`);
      spawnFlyingGemToHUD(pt.x, pt.y);
    }

    // Blacklist this diamond ID forever so no cloud sync or reload can ever restore it
    if (!state.collectedDiamondIds) state.collectedDiamondIds = [];
    state.collectedDiamondIds.push(did);
    // Keep list capped at recent 100 IDs
    if (state.collectedDiamondIds.length > 100) state.collectedDiamondIds.shift();

    delete state.liveDiamonds[did];
    state.diamonds = (Number(state.diamonds) || 0) + 1;
    Store.save();
    if (markers[did]) { markers[did].remove(); delete markers[did]; }
    onCollect();
  }

  function pruneExpired() {
    const state = Store.get();
    if (!state.liveDiamonds) state.liveDiamonds = {};
    const now = Date.now();
    let changed = false;
    for (const did in state.liveDiamonds) {
      if (now - state.liveDiamonds[did].spawnedAt > CONFIG.DIAMOND_LIFETIME_MS) {
        delete state.liveDiamonds[did];
        changed = true;
      }
    }
    if (changed) Store.save();
  }

  function trySpawn() {
    if (!playerPos) return;
    const state = Store.get();
    if (!state.liveDiamonds) state.liveDiamonds = {};
    pruneExpired();

    const now = Date.now();
    const spawnInterval = CONFIG.DIAMOND_SPAWN_CHECK_MS || 25000;

    if (state.lastDiamondSpawn && (now - state.lastDiamondSpawn < spawnInterval)) {
      return;
    }

    const collectRadius = CONFIG.DIAMOND_COLLECT_RADIUS_METERS || 75;
    const spawnRadius = CONFIG.DIAMOND_SPAWN_RADIUS_METERS || 1200;
    const INNER_WAVE_COOLDOWN = CONFIG.DIAMOND_INNER_COOLDOWN_MS || (8 * 60 * 1000);
    const MAX_ACTIVE = CONFIG.DIAMOND_MAX_ACTIVE || 36;

    if (!state.lastInnerWaveTime || (now - state.lastInnerWaveTime >= INNER_WAVE_COOLDOWN)) {
      state.lastInnerWaveTime = now;
      state.innerWaveSpawns = 0;
    }

    let diamondsInside = 0;
    let diamondsOutside = 0;
    for (const did in state.liveDiamonds) {
      const d = state.liveDiamonds[did];
      if (withinCollectRange(d.lat, d.lon)) diamondsInside++;
      else diamondsOutside++;
    }

    let spawnedAny = false;

    // --- TRACK 1: Outer Neighborhood Diamond Field (Water-Filtered!) ---
    if (diamondsOutside < (MAX_ACTIVE - 2)) {
      let attempts = 0;
      let targetPt = null;

      // Re-roll up to 5 times if point lands in an ocean, bay, or lake!
      while (attempts < 5) {
        attempts++;
        const angle = Math.random() * Math.PI * 2;
        const dist = collectRadius + 30 + Math.random() * (spawnRadius - collectRadius - 30);
        const dLat = (dist * Math.cos(angle)) / 111111;
        const dLon = (dist * Math.sin(angle)) / (111111 * Math.cos((playerPos.lat * Math.PI) / 180));
        const candLat = playerPos.lat + dLat;
        const candLon = playerPos.lon + dLon;

        if (!isPointInWater(candLat, candLon)) {
          targetPt = { lat: candLat, lon: candLon };
          break;
        }
      }

      if (targetPt) {
        state.liveDiamonds[id()] = { lat: targetPt.lat, lon: targetPt.lon, spawnedAt: now };
        spawnedAny = true;
      }
    }

    // --- TRACK 2: Inner Circle Couch Spawn (Up to 2 per 8-minute wave) ---
    const canSpawnInner = (state.innerWaveSpawns < 2) && (diamondsInside < 2);
    if (canSpawnInner) {
      const angleIn = Math.random() * Math.PI * 2;
      const distIn = 15 + Math.random() * (collectRadius - 30);
      const dLatIn = (distIn * Math.cos(angleIn)) / 111111;
      const dLonIn = (distIn * Math.sin(angleIn)) / (111111 * Math.cos((playerPos.lat * Math.PI) / 180));

      state.liveDiamonds[id()] = {
        lat: playerPos.lat + dLatIn,
        lon: playerPos.lon + dLonIn,
        spawnedAt: now
      };
      state.innerWaveSpawns = (state.innerWaveSpawns || 0) + 1;
      spawnedAny = true;
    }

    if (spawnedAny) {
      state.lastDiamondSpawn = now;
      Store.save();
      renderAll();
    }
  }

  function init(mapboxMap, callbacks) {
    map = mapboxMap;
    onCollect = callbacks.onCollect || onCollect;
    onDenied = callbacks.onDenied || onDenied;
    pruneExpired();

    // Initial Horizon Seed: If world has few diamonds, seed 12-16 immediately!
    const state = Store.get();
    const curCount = Object.keys(state.liveDiamonds || {}).length;
    if (curCount < 12 && playerPos) {
      for (let i = curCount; i < 16; i++) {
        trySpawn();
      }
    }

    renderAll();

    // Regular spawn ticker
    if (spawnTimer) clearInterval(spawnTimer);
    spawnTimer = setInterval(trySpawn, CONFIG.DIAMOND_SPAWN_CHECK_MS || 25000);
  }

  let lastPosUpdate = 0;
  let lastRenderPos = null;

  function setPlayerPosition(lat, lon) {
    const now = Date.now();
    playerPos = { lat, lon };

    const storedPosition = Store.get().lastDiamondPlayerPosition;
    const movedDistance = storedPosition
      ? Geo.haversine(storedPosition.lat, storedPosition.lon, lat, lon)
      : Infinity;
    if (!storedPosition || movedDistance >= (CONFIG.DIAMOND_MOVEMENT_THRESHOLD_METERS || 10)) {
      const state = Store.get();
      state.lastDiamondMovementAt = now;
      state.lastDiamondPlayerPosition = { lat, lon };
      Store.save();
    }

    // Throttle checks: Only re-render if moved > 2 meters or 3 seconds elapsed
    const distMoved = lastRenderPos ? Geo.haversine(lastRenderPos.lat, lastRenderPos.lon, lat, lon) : 999;

    if (distMoved > 2 || (now - lastPosUpdate > 3000)) {
      lastPosUpdate = now;
      lastRenderPos = { lat, lon };
      pruneExpired();
      trySpawn();
      renderAll();
    }
  }

  return { init, setPlayerPosition, renderAll };
})();
