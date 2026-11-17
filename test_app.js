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
  window: {matchMedia: () => ({matches: false})},
  requestAnimationFrame: () => 1,
  document: {getElementById: element},
  L: {
    divIcon: options => options,
    marker: (position, options) => ({position, options,
      on() { return this; }, addTo() { return this; }, bindPopup(popup) { this.popup = popup; return this; },
      getLatLng() { return {lat: this.position[0], lng: this.position[1]}; },
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
    getZoom: () => 8,
    latLngToContainerPoint: ([lat, lon]) => ({x: lon * 1000, y: -lat * 1000})
  };
  for (const method of ['polyline', 'polygon', 'circleMarker']) {
    L[method] = (points, options) => ({addTo() { courseItems.push({method, points, options}); return this; }});
  }
  L.marker = (point, options) => ({addTo() { courseItems.push({method: 'label', point, options}); return this; }});
  renderCourses([{id: 'one', kind: 'drone', lat: 50, lon: 34, heading: 90}]);
`);
assert.equal(courses.length, 4, 'all targets have a cone and centreline without selecting');
assert.equal(courses[0].method, 'polygon');
assert.ok(courses[0].options.fillOpacity < .1, 'cone stays translucent');
assert.ok(courses[3].points.at(-1)[1] > 34, 'eastward course extends east');
run("map.getZoom = () => 11; renderCourses([{id: 'one', kind: 'drone', lat: 50, lon: 34, heading: 0}]);");
assert.ok(courses.some(c => c.method === 'label' && c.options.icon.html.includes('≈')), 'estimated times are explicit');
assert.ok(courses.filter(c => c.method === 'label').length < 5, 'screen spacing hides crowded labels');
run("renderCourses([{id: 'one', kind: 'drone', lat: 50, lon: 34, heading: 0, velocity: {speedKmh: 600}}]);");
assert.ok(courses.some(c => c.method === 'label' && !c.options.icon.html.includes('≈')), 'reported speed has no estimate prefix');
run("renderCourses([{lat: 50, lon: 34, heading: null}, {lat: 50, lon: 34, heading: 90, areaOnly: true}]);");
assert.equal(courses.length, 0, 'no fabricated course for missing headings or area-only reports');
run("renderCourses([]);");
assert.equal(courses.length, 0, 'expired courses are cleared');
assert.ok(run("markerIcon({kind:'drone', heading:90}).html").includes('rotate(90deg)'));
assert.ok(!run("markerIcon({kind:'drone', heading:90}).html").includes('ic_drone'), 'generic UAV uses a fixed-wing symbol');
assert.equal(run("flightSpeed({kind:'drone'}).kmh"), 170);
assert.equal(run("flightSpeed({kind:'unknown'}).kmh"), null);
assert.equal(run("flightSpeed({velocity:{speedKmh: 250}}).estimated"), false);
assert.equal(run("motionPosition({from:[50,30],to:[52,34],start:1000}, 3400)[0]"), 51);
assert.equal(run("motionPosition({from:[50,30],to:[52,34],start:1000}, 9000)[0]"), 52, 'motion never extrapolates past source position');
run(`
  const movingMarker = {position:[50,30], getLatLng() {return {lat:this.position[0],lng:this.position[1]};}, setLatLng(p) {this.position=p;}};
  moveTarget(movingMarker, {id:'moving',lat:51,lon:31});
  const initialMotion = targetMotion.get('moving');
  moveTarget(movingMarker, {id:'moving',lat:51,lon:31});
  if (initialMotion !== targetMotion.get('moving')) throw new Error('Identical snapshots must not restart movement');
  window.matchMedia = () => ({matches:true});
  moveTarget(movingMarker, {id:'moving',lat:52,lon:32});
  if (movingMarker.position[0] !== 52 || targetMotion.has('moving')) throw new Error('Reduced motion must snap to new position');
`);
assert.ok(source.includes('5000 - (performance.now() - requestStarted)'), 'poll every 5 seconds including request time');
console.log('Flight rendering checks passed: always-visible cones, zoom/spacing, ETA provenance, bearings, interpolation and reduced motion.');
