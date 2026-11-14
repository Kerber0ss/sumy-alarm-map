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

let map, outline, districtGeo, markerLayer;
let selectedRegion = "";
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

function markerIcon(target) {
  const icons = new Set(["ic_airbomb", "ic_ballistic", "ic_banderol", "ic_drone", "ic_missile", "ic_shahed", "ic_shahed_jet", "ic_shahed_jet_mesh", "ic_shahed_mesh"]);
  const areaLevel = data.districts.find(d => d.id === target.districtId)?.level
    ?? data.regions.find(r => r.id === target.regionId)?.level;
  const fallback = areaLevel === "red" ? "ic_air_threat_combined_white" : "ic_shahed";
  const icon = target.classification && icons.has(target.iconName)
    ? `/icons/detected/${target.iconName}.svg` : `/icons/${fallback}.svg`;
  // Original SVG points north at 0°. Missing heading keeps its base orientation, not a claimed course.
  return L.divIcon({className: "target-marker", iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -24], html: `<div class="original-target ${target.fading ? "target-fading" : ""}"><img src="${icon}" alt="" width="44" height="44" style="transform:rotate(${target.heading ?? 0}deg)"></div>`});
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
  if (t.updatedAt && Number.isFinite(Date.parse(t.updatedAt))) notes.push(`Оновлено ${dateFormat.format(new Date(t.updatedAt))}`);
  return notes.map(escapeHTML).join("<br>");
}

function renderTargets(fresh) {
  const targets = fresh ? data.targets.filter(t => !selectedRegion || t.regionId === selectedRegion) : [];
  $("target-count").textContent = fresh ? targets.length : "—";
  const present = new Set(targets.filter(t => !t.areaOnly).map(t => t.id));
  for (const [id, marker] of targetMarkers) {
    if (!present.has(id)) { markerLayer.removeLayer(marker); targetMarkers.delete(id); }
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
    } else {
      marker.setLatLng([target.lat, target.lon]).setIcon(markerIcon(target)).setPopupContent(popup);
    }
  }
  if (!fresh) {
    $("targets").innerHTML = '<div class="empty-state">Немає свіжих даних про цілі<small>Застарілі позначки приховано. Повторюємо запит кожні 10 секунд.</small></div>';
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
  if (busy) return;
  busy = true;
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
      $("source-warning").textContent = "Не вдалося отримати дані. Наступна спроба через 10 секунд.";
      $("districts").textContent = "Дані тривог недоступні";
      $("targets").textContent = "Дані цілей недоступні";
    }
    console.warn("Refresh failed:", error.message);
  } finally {
    busy = false;
    window.setTimeout(refresh, 10000);
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
  markerLayer = L.layerGroup().addTo(map);
  const fit = () => {
    map.closePopup();
    const mobile = window.innerWidth <= 580 && !document.body.classList.contains("map-only");
    map.fitBounds((regionLayers.get(selectedRegion) || outline).getBounds(), {
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
    fit();
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
  void refresh();
}

start().catch(error => {
  $("fatal").hidden = false;
  $("fatal").textContent = error.message;
  $("connection-label").textContent = "Помилка завантаження карти";
});
