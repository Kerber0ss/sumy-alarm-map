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
      on() { return this; }, addTo() { return this; }, bindPopup(popup) { this.popup = popup; return this; },
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

const courses = [];
context.courseItems = courses;
run(`
  courseLayer = {clearLayers() { courseItems.length = 0; }};
  map = {
    latLngToContainerPoint: ([lat, lon]) => ({x: lon * 100, y: -lat * 100}),
    containerPointToLatLng: ([x, y]) => [-y / 100, x / 100]
  };
  L.polyline = (points, options) => ({addTo() { courseItems.push({points, options}); return this; }});
  selectedTargetId = null;
  renderCourses([{id: 'one', lat: 50, lon: 34, heading: 90}]);
`);
assert.equal(courses.length, 0, 'unselected targets never clutter the map with lines');
run("selectedTargetId = 'one'; renderCourses([{id: 'one', lat: 50, lon: 34, heading: 90}]);");
assert.equal(courses.length, 2);
assert.ok(courses[0].points[1][1] > courses[0].points[0][1], 'course points east');
run("renderCourses([{id: 'one', lat: 50, lon: 34, heading: null}]);");
assert.equal(courses.length, 0);
run("renderCourses([]);");
assert.equal(courses.length, 0);
assert.ok(run("markerIcon({kind:'shahed', heading:180}).html").includes('/icons/detected/ic_shahed.svg'));
assert.ok(run("markerIcon({kind:'drone', heading:90}).html").includes('rotate(0deg)'));
console.log('NEPTUN icons and selected-only course checks passed.');
