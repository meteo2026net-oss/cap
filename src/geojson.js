function parseDecimal(value) {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
  return Number(value);
}

function parsePolygon(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const pairs = value.trim().split(/\s+/).map(pair => {
    const parts = pair.split(",");
    if (parts.length !== 2) throw new Error("Invalid CAP polygon coordinates: malformed coordinate pair.");
    const lat = parseDecimal(parts[0]), lon = parseDecimal(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error("Invalid CAP polygon coordinates.");
    }
    return [lon, lat];
  });
  if (pairs.length < 4) throw new Error("GeoJSON polygon requires at least four coordinate pairs.");
  const first = pairs[0], last = pairs[pairs.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error("CAP polygon ring must be closed.");
  return pairs;
}

function areasForAlert(alert) {
  if (alert.info_json) {
    const blocks = JSON.parse(alert.info_json);
    return blocks.flatMap(block => (block.areas?.length ? block.areas : block.area ? [block.area] : []).map(area => ({ ...area, language: block.language })));
  }
  return [{ areaDesc: alert.area_desc, polygons: alert.polygon ? [alert.polygon] : [], circles: alert.circle ? [alert.circle] : [] }];
}

/**
 * Convert CAP alert rows to GeoJSON. CAP circles are represented as Points;
 * their radius is retained in properties because GeoJSON has no circle type.
 */
export function alertsToGeoJSON(alerts) {
  const features = [];
  for (const alert of alerts) {
    for (const area of areasForAlert(alert)) {
      const polygons = [...(area.polygons || []), ...(area.polygon ? [area.polygon] : [])];
      const circles = [...(area.circles || []), ...(area.circle ? [area.circle] : [])];
      for (const polygon of polygons) {
        const ring = parsePolygon(polygon);
        if (!ring) continue;
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: {
            identifier: alert.identifier, event: alert.event, headline: alert.headline,
            sent: alert.sent, status: alert.status, msg_type: alert.msg_type,
            urgency: alert.urgency, severity: alert.severity, certainty: alert.certainty,
            language: area.language || alert.language, area_description: area.areaDesc, geometry_kind: "polygon"
          }
        });
      }
      for (const circle of circles) {
        const parts = circle.trim().split(/\s+/);
        if (parts.length !== 2) throw new Error("Invalid CAP circle.");
        const coords = parts[0].split(",").map(parseDecimal), radius = parseDecimal(parts[1]);
        const [lat, lon] = coords;
        if (coords.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lon) ||
            Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(radius) || radius <= 0) {
          throw new Error("Invalid CAP circle coordinates or radius.");
        }
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            identifier: alert.identifier, event: alert.event, headline: alert.headline,
            sent: alert.sent, status: alert.status, msg_type: alert.msg_type,
            urgency: alert.urgency, severity: alert.severity, certainty: alert.certainty,
            language: area.language || alert.language, area_description: area.areaDesc,
            geometry_kind: "circle", radius_km: radius
          }
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}
