import { create } from "xmlbuilder2";
import { randomUUID } from "node:crypto";

const allowed = {
  urgency: ["Immediate", "Expected", "Future", "Past", "Unknown"],
  severity: ["Extreme", "Severe", "Moderate", "Minor", "Unknown"],
  certainty: ["Observed", "Likely", "Possible", "Unlikely", "Unknown"],
  status: ["Actual", "Exercise", "System", "Test", "Draft"],
  msg_type: ["Alert", "Update", "Cancel", "Ack", "Error"],
  scope: ["Public", "Restricted", "Private"]
};
const categories = ["Geo","Met","Safety","Security","Rescue","Fire","Health","Env","Transport","Infra","CBRNE","Other"];
const responseTypes = ["Shelter","Evacuate","Prepare","Execute","Avoid","Monitor","Assess","AllClear","None"];

function capDateTime(value, field) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date for ${field}.`);
  // CAP 1.2 requires a numeric timezone offset; the UTC designator Z is not permitted.
  return date.toISOString().replace(/\.\d{3}Z$/, "-00:00");
}
function validDate(value, field) { if (value) capDateTime(value, field); }

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
  if (points[0] !== points[points.length - 1]) throw new Error("A CAP polygon must be closed: repeat the first coordinate at the end.");
}
function validateArea(area) {
  if (!area?.areaDesc?.trim()) throw new Error("Every CAP area requires areaDesc.");
  const shapes = [...(area.polygons || []), ...(area.circles || [])];
  if (area.polygon) shapes.push(area.polygon);
  if (area.circle) shapes.push(area.circle);
  if (!shapes.length && !(area.geocodes || []).length) throw new Error("Every CAP area requires polygon, circle or geocode geometry.");
  for (const polygon of [...(area.polygons || []), ...(area.polygon ? [area.polygon] : [])]) validatePolygon(polygon);
  for (const circle of [...(area.circles || []), ...(area.circle ? [area.circle] : [])]) {
    const parts = circle.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].split(",").length !== 2) throw new Error("A CAP circle must use 'latitude,longitude radiusKm'.");
    const [lat, lon] = parts[0].split(",").map(Number), radius = Number(parts[1]);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(radius) || radius <= 0) {
      throw new Error("CAP circle coordinates or radius are invalid.");
    }
  }
  for (const item of area.geocodes || []) {
    if (!item.valueName?.trim() || !item.value?.trim()) throw new Error("CAP geocodes require valueName and value.");
  }
  if (area.altitude !== undefined && !Number.isFinite(Number(area.altitude))) throw new Error("CAP altitude must be numeric.");
  if (area.ceiling !== undefined && !Number.isFinite(Number(area.ceiling))) throw new Error("CAP ceiling must be numeric.");
}
function normalizeArea(area) {
  const out = { areaDesc: area.areaDesc };
  const polygons = [...(area.polygons || []), ...(area.polygon ? [area.polygon] : [])];
  const circles = [...(area.circles || []), ...(area.circle ? [area.circle] : [])];
  if (polygons.length) out.polygon = polygons;
  if (circles.length) out.circle = circles;
  if (area.geocodes?.length) out.geocode = area.geocodes.map(g => ({ valueName: g.valueName, value: g.value }));
  if (area.altitude !== undefined) out.altitude = String(area.altitude);
  if (area.ceiling !== undefined) out.ceiling = String(area.ceiling);
  return out;
}
function normalizeResource(resource) {
  if (!resource.resourceDesc?.trim() || !resource.mimeType?.trim()) throw new Error("CAP resources require resourceDesc and mimeType.");
  const out = { resourceDesc: resource.resourceDesc, mimeType: resource.mimeType };
  if (resource.size !== undefined) {
    if (!Number.isInteger(Number(resource.size)) || Number(resource.size) < 0) throw new Error("CAP resource size must be a non-negative integer.");
    out.size = String(resource.size);
  }
  for (const key of ["uri","derefUri","digest"]) if (resource[key]) out[key] = resource[key];
  return out;
}
function normalizeInfo(info) {
  const cats = info.categories || [info.category || "Met"];
  if (!cats.length || cats.some(c => !categories.includes(c))) throw new Error("CAP info requires at least one valid category.");
  if (info.response_types?.some(x => !responseTypes.includes(x))) throw new Error("Invalid CAP responseType.");
  if (info.response_type && !responseTypes.includes(info.response_type)) throw new Error("Invalid CAP responseType.");
  for (const field of ["effective","onset","expires"]) validDate(info[field], field);
  const out = {
    ...(info.language ? { language: info.language } : {}),
    category: cats,
    event: info.event,
    ...(info.response_types?.length ? { responseType: info.response_types } : info.response_type ? { responseType: info.response_type } : {}),
    urgency: info.urgency || "Unknown",
    severity: info.severity || "Unknown",
    certainty: info.certainty || "Unknown",
    ...(info.effective ? { effective: capDateTime(info.effective,"effective") } : {}),
    ...(info.onset ? { onset: capDateTime(info.onset,"onset") } : {}),
    ...(info.expires ? { expires: capDateTime(info.expires,"expires") } : {}),
    ...(info.senderName ? { senderName: info.senderName } : {}),
    ...(info.headline ? { headline: info.headline } : {}),
    ...(info.description ? { description: info.description } : {}),
    ...(info.instruction ? { instruction: info.instruction } : {}),
    ...(info.web ? { web: info.web } : {}),
    ...(info.contact ? { contact: info.contact } : {})
  };
  if (info.parameters?.length) out.parameter = info.parameters.map(p => ({ valueName: p.valueName, value: p.value }));
  if (info.resources?.length) out.resource = info.resources.map(normalizeResource);
  const areas = info.areas?.length ? info.areas : (info.area ? [info.area] : []);
  if (areas.length) {
    areas.forEach(validateArea);
    out.area = areas.map(normalizeArea);
  }
  return out;
}

export function validateAlert(input) {
  for (const [field, values] of Object.entries(allowed)) {
    if (input[field] && !values.includes(input[field])) throw new Error(`Invalid CAP ${field}`);
  }
  if (!input.identifier?.trim() || !input.sender?.trim() || !input.sent || !input.status || !input.msg_type || !input.scope) {
    throw new Error("CAP identifier, sender, sent, status, msgType and scope are required.");
  }
  if (/[ ,<>]/.test(input.identifier) || /[ ,<>]/.test(input.sender)) throw new Error("CAP identifier and sender cannot contain spaces, commas or angle brackets.");
  capDateTime(input.sent, "sent");
  const blocks = input.info_blocks?.length ? input.info_blocks : (["Cancel","Ack","Error"].includes(input.msg_type) ? [] : [{
    language: input.language, category: input.category, event: input.event, urgency: input.urgency,
    severity: input.severity, certainty: input.certainty, effective: input.effective, onset: input.onset,
    expires: input.expires, headline: input.headline, description: input.description,
    instruction: input.instruction, response_type: input.response_type,
    area: { areaDesc: input.area_desc, polygon: input.polygon, circle: input.circle }
  }];
  if (input.msg_type === "Alert" && !blocks.length) throw new Error("CAP Alert messages require at least one info block.");
  if (input.msg_type !== "Cancel" && input.msg_type !== "Ack" && input.msg_type !== "Error" && !blocks.length) throw new Error("This CAP message type requires an info block.");
  blocks.forEach(normalizeInfo);
  if (input.expires && input.onset && Date.parse(input.expires) <= Date.parse(input.onset)) throw new Error("Expiry must be later than onset.");
  return true;
}

export function makeIdentifier() { return `urn:uuid:${randomUUID()}`; }

export function buildCapXml(a) {
  validateAlert(a);
  const infos = a.info_blocks?.length ? a.info_blocks : [{
    language: a.language, category: a.category, event: a.event, urgency: a.urgency,
    severity: a.severity, certainty: a.certainty, effective: a.effective, onset: a.onset,
    expires: a.expires, headline: a.headline, description: a.description,
    instruction: a.instruction, response_type: a.response_type,
    area: { areaDesc: a.area_desc, polygon: a.polygon, circle: a.circle }
  }];
  const alert = {
    "@xmlns": "urn:oasis:names:tc:emergency:cap:1.2",
    identifier: a.identifier, sender: a.sender, sent: capDateTime(a.sent,"sent"),
    status: a.status, msgType: a.msg_type,
    ...(a.source ? { source: a.source } : {}),
    scope: a.scope,
    ...(a.restriction ? { restriction: a.restriction } : {}),
    ...(a.addresses ? { addresses: a.addresses } : {}),
    ...(a.codes?.length ? { code: a.codes } : {}),
    ...(a.note ? { note: a.note } : {}),
    ...(a.references_text ? { references: a.references_text } : {}),
    ...(a.incidents ? { incidents: a.incidents } : {})
  };
  if (!["Cancel","Ack","Error"].includes(a.msg_type)) alert.info = infos.map(normalizeInfo);
  return create({ alert }).end({ prettyPrint: true });
}
