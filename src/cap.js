import { create } from "xmlbuilder2";
import { randomUUID } from "node:crypto";

const allowed = {
  urgency: ["Immediate", "Expected", "Future", "Past", "Unknown"],
  severity: ["Extreme", "Severe", "Moderate", "Minor", "Unknown"],
  certainty: ["Observed", "Likely", "Possible", "Unlikely", "Unknown"],
  status: ["Actual", "Exercise", "System", "Test"],
  msg_type: ["Alert", "Update", "Cancel", "Ack", "Error"],
  scope: ["Public", "Restricted", "Private"]
};

function validDate(value, field) {
  if (value && !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid date for ${field}.`);
  }
}

function validatePolygon(value) {
  const points = value.trim().split(/\s+/);
  if (points.length < 4) throw new Error("A CAP polygon requires at least four coordinate pairs.");
  for (const pair of points) {
    const coordinates = pair.split(",");
    if (coordinates.length !== 2) throw new Error("Polygon points must use latitude,longitude format.");
    const [lat, lon] = coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error("Polygon coordinates must be valid latitude,longitude pairs.");
    }
  }
  if (points[0] !== points[points.length - 1]) {
    throw new Error("A CAP polygon must be closed: repeat the first coordinate at the end.");
  }
}

export function validateAlert(input) {
  for (const [field, values] of Object.entries(allowed)) {
    if (input[field] && !values.includes(input[field])) throw new Error(`Invalid CAP ${field}`);
  }
  if (!input.headline?.trim() || !input.description?.trim() || !input.event?.trim()) {
    throw new Error("Event, headline and description are required.");
  }
  if (!input.area_desc?.trim()) throw new Error("At least one affected area description is required.");
  if (!input.identifier?.trim() || !input.sender?.trim() || !input.sent || !input.status || !input.msg_type || !input.scope) throw new Error("CAP identifier, sender, sent, status, msgType and scope are required.");
  if (!input.polygon?.trim() && !input.circle?.trim()) throw new Error("A CAP area requires a polygon or circle; areaDesc alone is insufficient.");
  for (const field of ["sent", "effective", "onset", "expires"]) validDate(input[field], field);
  if (input.expires && input.onset && Date.parse(input.expires) <= Date.parse(input.onset)) {
    throw new Error("Expiry must be later than onset.");
  }
  if (input.polygon?.trim()) validatePolygon(input.polygon);
  if (input.circle?.trim()) {
    const parts = input.circle.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].split(",").length !== 2) {
      throw new Error("A CAP circle must use 'latitude,longitude radiusKm'.");
    }
    const [lat, lon] = parts[0].split(",").map(Number);
    const radius = Number(parts[1]);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(radius) || radius <= 0) {
      throw new Error("CAP circle coordinates or radius are invalid.");
    }
  }
  return true;
}

export function makeIdentifier() {
  return `urn:uuid:${randomUUID()}`;
}

export function buildCapXml(a) {
  validateAlert(a);
  const info = {
    language: a.language || "en-US",
    category: a.category || "Met",
    event: a.event,
    urgency: a.urgency || "Unknown",
    severity: a.severity || "Unknown",
    certainty: a.certainty || "Unknown",
    headline: a.headline,
    description: a.description,
    area: { areaDesc: a.area_desc }
  };
  if (a.response_type) info.responseType = a.response_type;
  if (a.effective) info.effective = new Date(a.effective).toISOString();
  if (a.onset) info.onset = new Date(a.onset).toISOString();
  if (a.expires) info.expires = new Date(a.expires).toISOString();
  if (a.instruction) info.instruction = a.instruction;
  if (a.polygon) info.area.polygon = a.polygon;
  if (a.circle) info.area.circle = a.circle;

  const root = {
    alert: {
      "@xmlns": "urn:oasis:names:tc:emergency:cap:1.2",
      identifier: a.identifier,
      sender: a.sender,
      sent: new Date(a.sent).toISOString(),
      status: a.status,
      msgType: a.msg_type,
      scope: a.scope,
      ...(a.references_text ? { references: a.references_text } : {}),
      info
    }
  };
  return create(root).end({ prettyPrint: true, headless: false });
}
