import test from "node:test";
import assert from "node:assert/strict";
import { alertsToGeoJSON } from "../src/geojson.js";

const base = {
  identifier: "urn:uuid:test", event: "Heavy rain", headline: "Rain warning",
  sent: "2026-11-04T00:00:00-00:00", status: "Actual", msg_type: "Alert",
  urgency: "Expected", severity: "Moderate", certainty: "Likely", language: "en-GB"
};

test("exports CAP polygon coordinates in GeoJSON longitude-latitude order", () => {
  const result = alertsToGeoJSON([{ ...base, area_desc: "District", polygon: "51,0 52,0 52,1 51,1 51,0" }]);
  assert.equal(result.type, "FeatureCollection");
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].geometry.type, "Polygon");
  assert.deepEqual(result.features[0].geometry.coordinates[0][0], [0, 51]);
  assert.equal(result.features[0].properties.area_description, "District");
});

test("exports CAP circles as GeoJSON points with radius metadata", () => {
  const result = alertsToGeoJSON([{ ...base, area_desc: "District", circle: "33.5,36.2 12" }]);
  assert.equal(result.features[0].geometry.type, "Point");
  assert.deepEqual(result.features[0].geometry.coordinates, [36.2, 33.5]);
  assert.equal(result.features[0].properties.radius_km, 12);
});

test("exports multiple multilingual areas as separate features", () => {
  const result = alertsToGeoJSON([{
    ...base,
    info_json: JSON.stringify([
      { language: "en-GB", area: { areaDesc: "North", circle: "51,-1 5" } },
      { language: "ar", areas: [{ areaDesc: "South", polygon: "30,30 31,30 31,31 30,31 30,30" }] }
    ])
  }]);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features.map(feature => feature.properties.area_description), ["North", "South"]);
});

test("rejects malformed polygons and circles instead of emitting invalid GeoJSON", () => {
  assert.throws(() => alertsToGeoJSON([{ ...base, polygon: "91,0 52,0 52,1 91,0" }]), /coordinates/);
  assert.throws(() => alertsToGeoJSON([{ ...base, circle: "51,-1 0" }]), /circle/);
});
