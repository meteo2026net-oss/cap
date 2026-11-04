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

import { polygonLatLngsToCap, circleToCap } from "../public/geojson-validation.js";

test("limits nested GeometryCollections and clips long feature identifiers", () => {
  let geometry = { type: "Point", coordinates: [1, 2] };
  for (let i = 0; i < 10; i++) geometry = { type: "GeometryCollection", geometries: [geometry] };
  assert.throws(() => validateImportedGeoJSON({ type: "FeatureCollection", features: [{
    type: "Feature", properties: {}, geometry
  }] }), /تداخل/);
  const id = "x".repeat(500);
  const result = validateImportedGeoJSON({ type: "FeatureCollection", features: [{
    type: "Feature", id, properties: {}, geometry: { type: "Point", coordinates: [1, 2] }
  }] });
  assert.equal(result.features[0].id.length, 128);
});

test("converts drawn Leaflet polygon points to closed CAP latitude-longitude text", () => {
  assert.equal(polygonLatLngsToCap([
    { lat: 33.5, lng: 36.2 }, { lat: 33.6, lng: 36.3 }, { lat: 33.7, lng: 36.4 }
  ]), "33.500000,36.200000 33.600000,36.300000 33.700000,36.400000 33.500000,36.200000");
  assert.throws(() => polygonLatLngsToCap([{ lat: 91, lng: 0 }, { lat: 0, lng: 0 }, { lat: 1, lng: 1 }]), /غير صالحة/);
});

test("converts drawn circle center and radius from meters to CAP kilometers", () => {
  assert.equal(circleToCap(33.5, 36.2, 12500), "33.500000,36.200000 12.50");
  assert.throws(() => circleToCap(33.5, 36.2, 0), /غير صالح/);
});
