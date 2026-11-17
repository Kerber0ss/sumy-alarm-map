"use strict";

const colors = {red: "#ff6878", yellow: "#f6c76a", none: "#7c9a9e", unknown: "#8997b6"};
const labels = {red: "Червона", yellow: "Жовта", none: "Не оголошена", unknown: "Немає даних"};
const kinds = {shahed: "Шахед", "shahed-jet": "Реактивний шахед", missile: "Крилата ракета", banderol: "Бандероль", airbomb: "КАБ", drone: "БПЛА", unknown: "Ціль · тип невідомий"};
Object.assign(kinds, {ballistic: "Балістична ракета", recon: "Розвідувальний БПЛА", fpv: "FPV-дрон", mig31k: "МіГ-31К"});
const directions = ["на північ", "на північний схід", "на схід", "на південний схід", "на південь", "на південний захід", "на захід", "на північний захід"];
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch]));
const $ = id => document.getElementById(id);
const timeFormat = new Intl.DateTimeFormat("uk-UA", {timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit"});
const dateFormat = new Intl.DateTimeFormat("uk-UA", {timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"});
const shortDistrict = name => name.replace(" район", "");
const course = heading => heading == null ? "Курс не вказаний" : `${directions[Math.round(heading / 45) % 8]} · ${Math.round(heading)}°`;

let map, outline, districtGeo, markerLayer, courseLayer;
let selectedRegion = "";
const targetMotion = new Map();
let animationFrame = 0, lastCourseFrame = 0, refreshTimer = 0;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const regionLayers = new Map();
let data = null, receivedAt = 0, lastFreshKey = "", busy = false, tileFailures = 0;
const districtLayers = new Map();
const targetMarkers = new Map();
const geometryById = new Map();

function freshness() {
  if (!data) return {alerts: false, targets: false};
  const elapsed = Math.max(0, (performance.now() - receivedAt) / 1000);
  const fresh = name => {
    const status = data.sources[name];
    if (!status.fresh || status.age + elapsed > 30) return false;
    return name !== "targets" || status.snapshotAge == null || status.snapshotAge + elapsed <= status.ttl;
  };
  return {alerts: fresh("alerts"), targets: fresh("targets")};
}

function districtPopup(district, fresh) {
  const level = fresh ? district.level : "unknown";
  const alerts = fresh ? district.alerts.map(a => `<div class="popup-level"><span class="badge ${a.level}">${labels[a.level]}</span> ${escapeHTML(a.reason)}${a.since && Number.isFinite(Date.parse(a.since)) ? `<br><span class="popup-note">З ${dateFormat.format(new Date(a.since))}</span>` : ""}</div>`).join("") : "<p>Актуальний стан тривоги недоступний.</p>";
  const local = fresh && district.local.length ? `<p class="popup-note">Тривоги районів:<br>${district.local.map(c => escapeHTML(c.name)).join("<br>")}</p>` : "";
  return `<strong>${escapeHTML(district.name)}</strong><p><span class="badge ${level}">${labels[level]}</span></p>${alerts}${local}`;
}

function renderDistricts(fresh) {
  const visible = data.districts.filter(d => !selectedRegion || d.regionId === selectedRegion);
  const ordered = [...visible].sort((a, b) => {
    const order = {red: 0, yellow: 1, unknown: 2, none: 3};
    return order[a.level] - order[b.level] || a.name.localeCompare(b.name, "uk");
  });
  $("active-count").textContent = fresh ? visible.filter(d => d.level !== "none").length : "—";
  $("district-total").textContent = `${visible.length} районів / міст`;
  $("districts").innerHTML = ordered.map(d => {
    const level = fresh ? d.level : "unknown";
    const levels = [...new Set(d.alerts.map(a => a.level))];
    const both = fresh && levels.includes("red") && levels.includes("yellow");
    const note = !fresh ? "Очікуємо актуальні дані" : d.local.length ? `Тривоги районів: ${d.local.length}` : d.level === "none" ? "За даними джерела" : "Повітряна тривога";
    return `<button class="district-row" type="button" data-district="${escapeHTML(d.id)}" style="--level-color:${colors[level]}"><span class="row-top"><span class="district-name">${escapeHTML(d.name)}</span><span class="badge ${level}">${labels[level]}</span></span>${both ? '<span class="dual-badge"><span class="badge yellow">Також жовта</span></span>' : ""}<span class="row-note">${escapeHTML(d.regionName)} · ${note}</span></button>`;
  }).join("");
  for (const district of data.districts) {
    const layer = districtLayers.get(district.id);
    const level = fresh ? district.level : "unknown";
    if (layer) {
      layer.setStyle({color: colors[level], fillColor: colors[level], fillOpacity: level === "none" ? .08 : level === "unknown" ? .1 : .27, weight: 1.8});
      if (layer.getPopup()) layer.setPopupContent(districtPopup(district, fresh));
      else layer.bindPopup(districtPopup(district, fresh));
    }
  }
  for (const region of data.regions) {
    const layer = regionLayers.get(region.id);
    const level = fresh ? region.level : "unknown";
    layer.setStyle({color: "#b2c5cb", fillColor: colors[level], fillOpacity: level === "none" ? .02 : .12, weight: 1.5});
    layer.bindPopup(districtPopup(region, fresh));
  }
}

function targetColor(kind) {
  return ({drone: "#72d1ff", shahed: "#72d1ff", "shahed-jet": "#ff6068",
    banderol: "#ff6068", recon: "#ffda63", mig31k: "#ffda63",
    missile: "#ff9b42", ballistic: "#ff454f", airbomb: "#ffda63",
    fpv: "#fff9ec", unknown: "#bcc7d5"})[kind] || "#bcc7d5";
}

// Original, nose-up silhouettes: generic UAVs use a fixed-wing symbol, not a quadcopter.
function markerIcon(target) {
  const shapes = {
    wing: '<g transform="scale(.75)"><path d="M16 2C17 2 17.5 4 18 7L19.5 15 29 26 29 28 19 24 18.5 29 13.5 29 13 24 3 28 3 26 12.5 15 14 7C14.5 4 15 2 16 2Z"/><path d="M16 8V24M13 26H19" fill="none" stroke="#327798" stroke-width=".9"/></g>',
    jet: '<g transform="scale(.75)"><path d="M16 2Q18 3 18 8L18 14 28 23 28 26 18 21 18 27 14 27 14 21 4 26 4 23 14 14 14 8Q14 3 16 2Z"/></g>',
    recon: '<path d="M12 2 13.5 10 23 13 23 15 13.5 14 13 20 17 21 17 23 12 22 7 23 7 21 11 20 10.5 14 1 15 1 13 10.5 10Z"/>',
    missile: '<path d="M12 1Q15 5 14 14L18 19 14 18 14 23 10 23 10 18 6 19 10 14Q9 5 12 1Z"/>',
    fpv: '<path d="M10 7H14V17H10ZM5 4 19 20M19 4 5 20"/><path fill="none" d="M1 4H9M15 4H23M1 20H9M15 20H23"/>',
    unknown: '<path d="M12 2 21 21 12 17 3 21Z"/>'
  };
  const kind = target.kind;
  const shape = kind === "shahed-jet" ? "jet" : ["drone", "shahed"].includes(kind) ? "wing"
    : ["missile", "ballistic", "airbomb"].includes(kind) ? "missile"
    : ["recon", "banderol", "mig31k"].includes(kind) ? "recon" : kind === "fpv" ? "fpv" : "unknown";
  const color = targetColor(kind);
  const hasCourse = Number.isFinite(target.heading);
  const heading = target.displayHeading ?? (hasCourse ? target.heading : 0);
  const zoom = map?.getZoom?.() ?? 10;
  const size = zoom < 7 ? 20 : zoom < 9 ? 24 : 28;
  return L.divIcon({className: "target-marker", iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2], html: `<div class="flight-symbol ${target.fading ? "target-fading" : ""} ${hasCourse ? "" : "course-unknown"}" title="${hasCourse ? "Курс відомий" : "Курс невідомий"}" style="--flight-color:${color}"><svg class="flight-rotation" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${heading}deg)">${shapes[shape]}</svg><span class="course-unknown-badge" aria-hidden="true">?</span></div>`});
}

// Speeds are explicit visual estimates when the public source omits velocity.
function flightSpeed(target) {
  const reported = target.velocity?.speedKmh;
  if (Number.isFinite(reported) && reported > 0 && reported <= 10000) return {kmh: reported, estimated: false};
  const typical = {drone: 170, shahed: 170, "shahed-jet": 450, banderol: 540, missile: 750, ballistic: 3000};
  return {kmh: typical[target.kind] || null, estimated: true};
}

// Great-circle destination, so course and distance remain correct at every map zoom.
function coursePoint(target, distanceKm, heading = target.heading) {
  const rad = Math.PI / 180, arc = distanceKm / 6371;
  const lat = target.lat * rad, lon = target.lon * rad, bearing = heading * rad;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(bearing));
  return [nextLat / rad, (lon + Math.atan2(Math.sin(bearing) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(nextLat))) / rad];
}

function courseGeometry(target, minutes, scale = 1) {
  const speed = flightSpeed(target).kmh;
  const steps = Math.max(6, Math.round(24 * scale)), dt = minutes * scale / steps;
  let middle = [target.lat, target.lon], left = middle, right = middle;
  const line = [middle], leftEdge = [], rightEdge = [];
  for (let i = 1; i <= steps; i++) {
    const time = (i - .5) * dt;
    const width = 6 + 24 * Math.min(1, time / minutes);
    const distance = speed * dt / 60;
    const advance = (point, bearing) => coursePoint({lat: point[0], lon: point[1]}, distance, bearing);
    middle = advance(middle, target.heading);
    left = advance(left, target.heading - width);
    right = advance(right, target.heading + width);
    line.push(middle); leftEdge.push(left); rightEdge.push(right);
  }
  return {line, polygon: [[target.lat, target.lon], ...leftEdge, ...rightEdge.reverse()]};
}

function visibleTargets() {
  return data && freshness().targets ? data.targets.filter(t => !selectedRegion || t.regionId === selectedRegion) : [];
}

function renderCourses(targets) {
  if (!courseLayer) return;
  courseLayer.clearLayers();
  const occupied = [];
  for (const sample of targets) {
    if (sample.areaOnly || !Number.isFinite(sample.heading)) continue;
    const marker = targetMarkers.get(sample.id);
    const position = marker?.getLatLng();
    const target = position ? {...sample, lat: position.lat, lon: position.lng} : sample;
    const speed = flightSpeed(target);
    const color = speed.kmh >= 600 ? "#ff7954" : "#ffc247";
    const style = {color, interactive: false, weight: 1, opacity: .4};
    if (!speed.kmh) {
      // Unknown type/speed: show direction only, without invented ETA.
      L.polyline([[target.lat, target.lon], coursePoint(target, 5)], {...style, opacity: .5}).addTo(courseLayer);
      continue;
    }
    const minutes = target.kind === "ballistic" ? 2 : 5;
    const full = courseGeometry(target, minutes);
    for (const [scale, opacity] of [[1, .055], [.66, .04], [.33, .035]]) {
      L.polygon(scale === 1 ? full.polygon : courseGeometry(target, minutes, scale).polygon,
        {...style, stroke: scale === 1, dashArray: "4 5", fillOpacity: opacity}).addTo(courseLayer);
    }
    L.polyline(full.line, {...style, opacity: .55, weight: 1.2}).addTo(courseLayer);
    if (map.getZoom() < 10) continue;
    const origin = map.latLngToContainerPoint([target.lat, target.lon]);
    let last = origin;
    for (let minute = 1; minute <= minutes; minute++) {
      const point = coursePoint(target, speed.kmh * minute / 60);
      const pixel = map.latLngToContainerPoint(point);
      // Space by actual screen distance, and avoid labels from neighbouring targets.
      if (Math.hypot(pixel.x - last.x, pixel.y - last.y) < 42) continue;
      last = pixel;
      if (occupied.some(p => Math.abs(p.x - pixel.x) < 48 && Math.abs(p.y - pixel.y) < 24)) continue;
      occupied.push(pixel);
      L.circleMarker(point, {...style, radius: 2, weight: .8, color: "#382712", fillColor: color, fillOpacity: .9, opacity: .9}).addTo(courseLayer);
      L.marker(point, {interactive: false, keyboard: false, icon: L.divIcon({className: "flight-eta", iconSize: [48, 18], iconAnchor: [24, 23], html: `${speed.estimated ? "≈" : ""}${minute} хв`})}).addTo(courseLayer);
    }
  }
}

function motionPosition(motion, now) {
  const t = Math.min(1, Math.max(0, (now - motion.start) / 4800));
  return [motion.from[0] + (motion.to[0] - motion.from[0]) * t,
    motion.from[1] + (motion.to[1] - motion.from[1]) * t];
}

function animateTargets(now) {
  animationFrame = 0;
  if (document.hidden) return;
  let active = false;
  for (const [id, motion] of targetMotion) {
    const marker = targetMarkers.get(id);
    if (!marker) { targetMotion.delete(id); continue; }
    marker.setLatLng(motionPosition(motion, now));
    if (now - motion.start < 4800) active = true;
    else targetMotion.delete(id);
  }
  if (!active || now - lastCourseFrame > 250) {
    lastCourseFrame = now;
    renderCourses(visibleTargets());
  }
  if (active) animationFrame = requestAnimationFrame(animateTargets);
}

function moveTarget(marker, target) {
  const previous = marker.getLatLng();
  const to = [target.lat, target.lon];
  const pending = targetMotion.get(target.id);
  if (pending?.to[0] === to[0] && pending?.to[1] === to[1]) return;
  if (previous.lat === to[0] && previous.lng === to[1]) return;
  if (reducedMotion() || document.hidden) {
    targetMotion.delete(target.id);
    marker.setLatLng(to);
    return;
  }
  targetMotion.set(target.id, {from: [previous.lat, previous.lng], to, start: performance.now()});
  if (!animationFrame) animationFrame = requestAnimationFrame(animateTargets);
}

function updateTargetIcon(marker, target) {
  const rotation = marker.getElement?.()?.querySelector(".flight-rotation");
  const old = marker.flightHeading ?? target.heading ?? 0;
  const next = Number.isFinite(target.heading) ? old + (((target.heading - old) % 360 + 540) % 360) - 180 : old;
  marker.flightHeading = next;
  if (rotation && marker.flightKind === target.kind) {
    rotation.style.transform = `rotate(${next}deg)`;
    rotation.parentElement.classList.toggle("target-fading", !!target.fading);
    rotation.parentElement.classList.toggle("course-unknown", !Number.isFinite(target.heading));
    rotation.parentElement.title = Number.isFinite(target.heading) ? "Курс відомий" : "Курс невідомий";
  } else {
    marker.setIcon(markerIcon({...target, displayHeading: next}));
    marker.flightKind = target.kind;
  }
}

function targetDetails(t) {
  const confidence = {low: "низька", medium: "середня", high: "висока"};
  const notes = [];
  if (t.areaOnly) notes.push("Повідомлення про область — точне місце невідоме");
  if (t.advisory) notes.push("Інформаційне спостереження");
  if (t.presumptiveCourse) notes.push("Курс імовірний");
  if (Number.isFinite(t.count) && t.count > 0) notes.push(`У групі: ${t.count}`);
  if (confidence[t.confidence]) notes.push(`Достовірність: ${confidence[t.confidence]}`);
  if (Number.isFinite(t.sourceCount)) notes.push(`Джерел: ${t.sourceCount}`);
  if (!t.areaOnly && Number.isFinite(t.uncertaintyKm)) notes.push(`Невизначеність позиції: ${t.uncertaintyKm} км`);
  if (!t.areaOnly && Number.isFinite(t.velocity?.speedKmh)) notes.push(`Швидкість: ${t.velocity.speedKmh} км/год`);
  const speed = flightSpeed(t);
  if (!t.areaOnly && speed.kmh && speed.estimated) notes.push(`Час на лінії ≈ за типовою швидкістю ${speed.kmh} км/год, не вимірювання`);
  if (t.updatedAt && Number.isFinite(Date.parse(t.updatedAt))) notes.push(`Оновлено ${dateFormat.format(new Date(t.updatedAt))}`);
  return notes.map(escapeHTML).join("<br>");
}

function renderTargets(fresh) {
  const targets = fresh ? data.targets.filter(t => !selectedRegion || t.regionId === selectedRegion) : [];
  $("target-count").textContent = fresh ? targets.length : "—";
  const present = new Set(targets.filter(t => !t.areaOnly).map(t => t.id));
  for (const [id, marker] of targetMarkers) {
    if (!present.has(id)) { markerLayer.removeLayer(marker); targetMarkers.delete(id); targetMotion.delete(id); }
  }
  for (const target of targets) {
    if (target.areaOnly) continue;
    const title = target.title || kinds[target.kind] || kinds.unknown;
    const district = data.districts.find(d => d.id === target.districtId);
    const popup = `<strong>${escapeHTML(title)}</strong><p>${escapeHTML([target.locality || district?.name, target.region].filter(Boolean).join(" · ") || "Україна")}</p><p>${escapeHTML(course(target.heading))}</p><p>${escapeHTML(target.description)}</p><p class="popup-note">${targetDetails(target)}</p><p class="popup-note">Приблизно ${target.lat.toFixed(2)}° N, ${target.lon.toFixed(2)}° E<br>Публічна позначка; позиція може бути затримана.${target.fading ? "<br>Позначка згасає у джерелі." : ""}</p>`;
    let marker = targetMarkers.get(target.id);
    if (!marker) {
      marker = L.marker([target.lat, target.lon], {icon: markerIcon(target), title: title, keyboard: true}).addTo(markerLayer).bindPopup(popup);
      targetMarkers.set(target.id, marker);
      marker.flightKind = target.kind;
      marker.flightHeading = target.heading ?? 0;
    } else {
      moveTarget(marker, target);
      updateTargetIcon(marker, target);
      marker.setPopupContent(popup);
    }
  }
  renderCourses(targets);
  if (!fresh) {
    $("targets").innerHTML = '<div class="empty-state">Немає свіжих даних про цілі<small>Застарілі позначки приховано. Повторюємо запит кожні 5 секунд.</small></div>';
  } else if (!targets.length) {
    $("targets").innerHTML = '<div class="empty-state">У джерелі немає позначок для обраної території<small>Це не означає відсутності загроз. Орієнтуйтеся на офіційні тривоги.</small></div>';
  } else {
    $("targets").innerHTML = targets.map((t, i) => `<button class="target-card" type="button" data-target="${escapeHTML(t.id)}"><span class="target-title"><strong>${escapeHTML(t.title || kinds[t.kind] || kinds.unknown)}</strong><span class="target-label">${String(i + 1).padStart(2, "0")}${t.fading ? " · ЗГАСАЄ" : ""}</span></span><span class="target-location">${escapeHTML([t.locality || data.districts.find(d => d.id === t.districtId)?.name, t.region].filter(Boolean).join(" · ") || "Україна")}</span><span class="target-meta">${t.heading == null ? "" : `<span class="target-course-arrow" style="transform:rotate(${t.heading}deg)">↑</span>`}${escapeHTML(t.areaOnly ? "Точне місце невідоме" : course(t.heading))}</span><span class="target-meta">${targetDetails(t)}</span>${t.description ? `<span class="target-meta">${escapeHTML(t.description)}</span>` : ""}</button>`).join("");
  }
}

function updateStatus() {
  if (!data) return;
  const fresh = freshness();
  const allFresh = fresh.alerts && fresh.targets;
  $("connection-dot").className = `status-dot ${allFresh ? "fresh" : "failed"}`;
  $("connection-label").textContent = allFresh ? "Дані оновлюються" : "Частина даних недоступна";
  const times = Object.values(data.sources).map(s => s.fetchedAt).filter(Boolean);
  $("updated").textContent = times.length ? `Отримано ${timeFormat.format(new Date(Math.min(...times) * 1000))} · Київ` : "Чекаємо дані джерела";
  const issues = [];
  if (!fresh.alerts) issues.push("Рівні тривог не підтверджені свіжим запитом.");
  if (!fresh.targets) issues.push("Свіжих даних про цілі немає; позначки приховано.");
  if (data.rejectedTargets) issues.push("Частину некоректних позначок пропущено.");
  if (tileFailures >= 3) issues.push("Фонова карта завантажується з помилками; межі й позначки залишаються доступними.");
  $("source-warning").hidden = !issues.length;
  $("source-warning").textContent = issues.join(" ");
  const key = `${fresh.alerts}:${fresh.targets}`;
  if (key !== lastFreshKey) {
    lastFreshKey = key;
    renderDistricts(fresh.alerts);
    renderTargets(fresh.targets);
  }
}

async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  const requestStarted = performance.now();
  try {
    const response = await fetch("/api/state", {cache: "no-store", signal: AbortSignal.timeout(18000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.regions) || !Array.isArray(next.districts) || !Array.isArray(next.targets) || !next.sources?.alerts || !next.sources?.targets) throw new Error("Невідомий формат даних");
    data = next;
    receivedAt = performance.now();
    lastFreshKey = "";
    updateStatus();
  } catch (error) {
    if (data) {
      for (const source of Object.values(data.sources)) source.fresh = false;
      updateStatus();
    } else {
      $("connection-dot").className = "status-dot failed";
      $("connection-label").textContent = "Немає зв’язку з сервером";
      $("source-warning").hidden = false;
      $("source-warning").textContent = "Не вдалося отримати дані. Наступна спроба через 5 секунд.";
      $("districts").textContent = "Дані тривог недоступні";
      $("targets").textContent = "Дані цілей недоступні";
    }
    console.warn("Refresh failed:", error.message);
  } finally {
    busy = false;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, Math.max(0, 5000 - (performance.now() - requestStarted)));
  }
}

async function start() {
  if (!window.L) throw new Error("Не вдалося завантажити бібліотеку карти.");
  const response = await fetch("/ukraine.geojson");
  if (!response.ok) throw new Error("Не вдалося завантажити межі України.");
  const geometry = await response.json();
  for (const feature of geometry.features) geometryById.set(String(feature.properties.regionId), feature);
  map = L.map("map", {zoomControl: false, minZoom: 3, maxZoom: 15, zoomSnap: .1, preferCanvas: false});
  map.attributionControl.addAttribution('<a href="https://neptun.in.ua/" target="_blank" rel="noopener">Дані: NEPTUN</a>');
  L.control.zoom({position: "topright"}).addTo(map);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
  tiles.on("tileerror", () => { tileFailures++; updateStatus(); });
  const regions = geometry.features.filter(f => f.properties.rank === 1);
  const parents = new Set(geometry.features.map(f => f.properties.parentId).filter(Boolean));
  outline = L.geoJSON({type: "FeatureCollection", features: regions}, {
    style: {color: "#b2c5cb", fillOpacity: .1, weight: 1.5},
    onEachFeature(feature, layer) {
      regionLayers.set(feature.properties.regionId, layer);
      layer.bindTooltip(feature.properties.name, {direction: "center", className: "district-label"});
    }
  }).addTo(map);
  districtGeo = L.geoJSON(geometry, {
    filter: f => f.properties.rank === 2 || !parents.has(f.properties.regionId),
    style: {color: colors.unknown, fillColor: colors.unknown, fillOpacity: .1, weight: 1},
    onEachFeature(feature, layer) {
      districtLayers.set(feature.properties.regionId, layer);
      layer.bindTooltip(shortDistrict(feature.properties.name), {direction: "center", className: "district-label"});
    }
  }).addTo(map);
  $("region-filter").innerHTML = '<option value="">Вся Україна</option>' + regions
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name, "uk"))
    .map(f => `<option value="${escapeHTML(f.properties.regionId)}">${escapeHTML(f.properties.name)}</option>`).join("");
  $("region-filter").addEventListener("change", () => {
    selectedRegion = $("region-filter").value;
    if (data) {
      const fresh = freshness();
      renderDistricts(fresh.alerts);
      renderTargets(fresh.targets);
    }
    map.fitBounds((regionLayers.get(selectedRegion) || outline).getBounds(), {padding: [25, 75]});
  });
  courseLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("zoomend", () => {
    for (const target of visibleTargets()) {
      const marker = targetMarkers.get(target.id);
      if (marker) {
        marker.setIcon(markerIcon({...target, displayHeading: marker.flightHeading}));
      }
    }
    if (data) renderCourses(visibleTargets());
  });
  const fit = (bounds) => {
    map.closePopup();
    const mobile = window.innerWidth <= 580 && !document.body.classList.contains("map-only");
    map.fitBounds(bounds || (regionLayers.get(selectedRegion) || regionLayers.get("oblast:сумська") || outline).getBounds(), {
      animate: false,
      paddingTopLeft: mobile ? [25, 70] : [12, 12],
      paddingBottomRight: mobile ? [25, 100] : [12, 12]
    });
  };
  fit();
  map.setMaxBounds(outline.getBounds().pad(.7));
  let resizeFrame = 0;
  const resizeMap = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      map.invalidateSize({pan: false});
      fit();
    });
  };
  new ResizeObserver(resizeMap).observe($("map"));
  $("fit-map").addEventListener("click", () => {
    selectedRegion = "";
    $("region-filter").value = "";
    if (data) {
      const fresh = freshness();
      renderDistricts(fresh.alerts);
      renderTargets(fresh.targets);
    }
    fit(outline.getBounds());
  });
  $("toggle-interface").addEventListener("click", () => {
    const mapOnly = document.body.classList.toggle("map-only");
    const button = $("toggle-interface");
    button.setAttribute("aria-expanded", String(!mapOnly));
    button.title = mapOnly ? "Показати всі елементи інтерфейсу" : "Сховати панелі й залишити тільки карту";
    button.querySelector("span").textContent = mapOnly ? "Показати панелі" : "Тільки карта";
    resizeMap();
  });
  $("districts").addEventListener("click", event => {
    const row = event.target.closest("[data-district]");
    if (!row) return;
    const layer = districtLayers.get(row.dataset.district);
    map.fitBounds(layer.getBounds(), {padding: [35, 100], maxZoom: 10});
    layer.openPopup();
  });
  $("targets").addEventListener("click", event => {
    const row = event.target.closest("[data-target]");
    if (!row) return;
    const marker = targetMarkers.get(row.dataset.target);
    if (!marker) {
      const target = data.targets.find(t => t.id === row.dataset.target);
      const region = regionLayers.get(target?.regionId);
      if (region) { map.fitBounds(region.getBounds(), {padding: [25, 75]}); region.openPopup(); }
      return;
    }
    map.setView(marker.getLatLng(), 11);
    marker.openPopup();
    if (window.innerWidth <= 580) $("map").scrollIntoView({behavior: "smooth", block: "start"});
  });
  window.setInterval(updateStatus, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(animationFrame); animationFrame = 0;
    } else {
      for (const [id, motion] of targetMotion) targetMarkers.get(id)?.setLatLng(motion.to);
      targetMotion.clear();
      window.clearTimeout(refreshTimer);
      void refresh();
    }
  });
  void refresh();
}

start().catch(error => {
  $("fatal").hidden = false;
  $("fatal").textContent = error.message;
  $("connection-label").textContent = "Помилка завантаження карти";
});
