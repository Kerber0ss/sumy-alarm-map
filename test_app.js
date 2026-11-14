"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {textContent: "", innerHTML: ""});
  return elements.get(id);
};
const removed = [];
const context = vm.createContext({
  Intl, Map, Set, performance,
  document: {getElementById: element},
  L: {
    divIcon: options => options,
    marker: (position, options) => ({position, options,
      addTo() { return this; }, bindPopup(popup) { this.popup = popup; return this; },
      setLatLng(value) { this.position = value; return this; },
      setIcon(value) { this.options.icon = value; return this; },
      setPopupContent(value) { this.popup = value; return this; }
    })
  }
});
const source = fs.readFileSync("public/app.js", "utf8");
vm.runInContext(source.slice(0, source.lastIndexOf("start().catch(")), context);
const run = code => vm.runInContext(code, context);
context.testRemoved = removed;
run(`
  markerLayer = {removeLayer: marker => testRemoved.push(marker)};
  data = {
    regions: [{id: "oblast:сумська", name: "Сумська область", level: "none", alerts: [], local: []},
              {id: "oblast:одеська", name: "Одеська область", level: "red", alerts: [], local: []}],
    districts: [{id: "raion:сумський", name: "Сумський район", regionId: "oblast:сумська", regionName: "Сумська область", level: "none", alerts: [], local: []},
                {id: "raion:одеський", name: "Одеський район", regionId: "oblast:одеська", regionName: "Одеська область", level: "red", alerts: [], local: []}],
    targets: [{id: "sumy", title: "<script>test</script>", lat: 50.91, lon: 34.8, heading: 90, regionId: "oblast:сумська", region: "Сумська область", districtId: "raion:сумський"},
              {id: "odesa", title: "БПЛА", lat: 46.5, lon: 30.7, heading: null, regionId: "oblast:одеська", region: "Одеська область", districtId: "raion:одеський"},
              {id: "area", title: "Загроза області", lat: 46.5, lon: 30.7, areaOnly: true, heading: null, regionId: "oblast:одеська", region: "Одеська область"}]
  };
  for (const region of data.regions) regionLayers.set(region.id, {setStyle() {}, bindPopup() {}});
  renderDistricts(true);
  renderTargets(true);
`);
assert.equal(element("active-count").textContent, 1);
assert.equal(element("target-count").textContent, 3);
assert.equal(run("targetMarkers.size"), 2, "area-only reports must not create point markers");
assert.ok(element("targets").innerHTML.includes("&lt;script&gt;test&lt;/script&gt;"));
assert.ok(!element("targets").innerHTML.includes("<script>"));
assert.ok(run('targetMarkers.get("sumy").options.icon.html').includes("rotate(90deg)"));
assert.ok(element("targets").innerHTML.includes("Точне місце невідоме"));
run('selectedRegion = "oblast:одеська"; renderDistricts(true); renderTargets(true);');
assert.equal(element("target-count").textContent, 2);
assert.equal(run("targetMarkers.size"), 1);
assert.ok(!element("districts").innerHTML.includes("Сумський район"));
run("renderDistricts(false); renderTargets(false);");
assert.equal(run("targetMarkers.size"), 0, "expired data must remove all markers");
assert.equal(element("active-count").textContent, "—");
assert.ok(element("districts").innerHTML.includes("Немає даних"));
console.log("Map rendering checks passed: country coverage, filtering, courses, area-only reports, escaping, expiry.");
