import test from "node:test";
import assert from "node:assert/strict";
import { validateImportedGeoJSON } from "../public/geojson-validation.js";

const point = (coordinates = [36.2, 33.5]) => ({
  type: "Feature", geometry: { type: "Point", coordinates },
  properties: { headline: "تنبيه", html: "<img src=x onerror=alert(1)>", severity: "Severe" }
});

test("accepts valid FeatureCollection and retains only safe display properties", () => {
  const result = validateImportedGeoJSON({ type: "FeatureCollection", features: [point()] });
  assert.equal(result.features[0].properties.headline, "تنبيه");
  assert.equal(result.features[0].properties.severity, "Severe");
  assert.equal("html" in result.features[0].properties, false);
});

test("rejects invalid collection, geometry type and out-of-range coordinates", () => {
  assert.throws(() => validateImportedGeoJSON({ type: "Feature", features: [] }), /FeatureCollection/);
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [point([181, 0])] }), /إحداثيات/);
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [{
    type: "Feature", geometry: { type: "Unknown", coordinates: [] }, properties: {}
  }] }), /غير مدعوم/);
});

test("rejects unclosed polygon rings and malformed features", () => {
  const polygon = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1]]] } };
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [polygon] }), /غير مغلقة/);
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [{ type: "FeatureCollection" }] }), /ليس Feature/);
});

test("rejects excessive coordinate counts", () => {
  const coords = Array.from({ length: 100001 }, (_, i) => [i % 180, 0]);
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [{
    type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords }
  }] }), /100000/);
});
