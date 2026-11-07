import { create } from "xmlbuilder2";
import { randomUUID } from "node:crypto";

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && value["#"] !== undefined) return String(value["#"]);
  return String(value);
}

const allowed = {
  urgency: ["Immediate", "Expected", "Future", "Past", "Unknown"],
  severity: ["Extreme", "Severe", "Moderate", "Minor", "Unknown"],
  certainty: ["Observed", "Likely", "Possible", "Unlikely", "Unknown"],
  status: ["Actual", "Exercise", "System", "Test"],
  msg_type: ["Alert", "Update", "Cancel", "Ack", "Error"],
  scope: ["Public", "Restricted", "Private"]
};
const categories = ["Geo","Met","Safety","Security","Rescue","Fire","Health","Env","Transport","Infra","CBRNE","Other"];
const responseTypes = ["Shelter","Evacuate","Prepare","Execute","Avoid","Monitor","Assess","AllClear","None"];

function validateReferences(value) {
  const references = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!references.length) throw new Error("CAP Update, Cancel, Ack and Error messages must reference the related message.");

  for (const reference of references) {
    const parts = reference.split(",");
    if (parts.length !== 3 || parts.some(part => !part.trim())) {
      throw new Error("CAP references must be whitespace-separated sender,identifier,sent triplets.");
    }
    const [sender, identifier, sent] = parts;
    if (/[\s<>]/.test(sender) || /[\s<>]/.test(identifier)) {
      throw new Error("CAP reference sender and identifier cannot contain whitespace or angle brackets.");
    }
    const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(sent);
    if (!timestamp || !Number.isFinite(Date.parse(sent))) {
      throw new Error("CAP reference sent timestamp must be a valid ISO 8601 date-time with a timezone.");
    }
    const [year, month, day, hour, minute, second] = timestamp.slice(1, 7).map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(hour, minute, second, 0);
    const offsetHour = timestamp[9] === undefined ? 0 : Number(timestamp[9]);
    const offsetMinute = timestamp[10] === undefined ? 0 : Number(timestamp[10]);
    if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
        calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
        offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new Error("CAP reference sent timestamp contains an out-of-range date, time or timezone offset.");
    }
  }
  return references.length;
}

function capDateTime(value, field) {
  if (!value) return undefined;
  // JavaScript Date normalizes impossible calendar dates (for example, 30 February).
  // Reject malformed ISO calendar/time components before parsing to prevent silent changes.
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(String(value));
  if (!iso) throw new Error(`Invalid date for ${field}; CAP date-time values must include an explicit timezone.`);
  {
    const [year, month, day, hour, minute, second] = iso.slice(1, 7).map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(hour, minute, second, 0);
    const offsetHour = iso[10] === undefined ? 0 : Number(iso[10]);
    const offsetMinute = iso[11] === undefined ? 0 : Number(iso[11]);
    if (year < 1 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
        calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
        offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new Error(`Invalid date for ${field}.`);
    }
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date for ${field}.`);
  // CAP 1.2 requires a numeric timezone offset; the UTC designator Z is not permitted.
  return date.toISOString().replace(/\.\d{3}Z$/, "-00:00");
}
function validDate(value, field) { if (value) capDateTime(value, field); }

function decimalNumber(value) {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
  return Number(value);
}
function isDecimalValue(value) {
  return (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && Number.isFinite(decimalNumber(value)));
}
function validatePolygon(value) {
  const points = value.trim().split(/\s+/).map(pair => {
    const coordinates = pair.split(",");
    if (coordinates.length !== 2) throw new Error("Polygon points must use latitude,longitude format.");
    const [lat, lon] = coordinates.map(decimalNumber);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error("Polygon coordinates must be valid latitude,longitude pairs.");
    }
    return [lat, lon];
  });
  if (points.length < 4) throw new Error("A CAP polygon requires at least four coordinate pairs.");
  const first = points[0], last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error("A CAP polygon must be closed: repeat the first coordinate at the end.");
  }
}
function validateArea(area) {
  if (!area || typeof area !== "object" || Array.isArray(area)) {
    throw new Error("Each CAP area must be an object.");
  }
  for (const field of ["polygons", "circles", "geocodes"]) {
    if (area[field] !== undefined && !Array.isArray(area[field])) {
      throw new Error(`CAP area ${field} must be an array.`);
    }
  }
  for (const field of ["polygon", "circle"]) {
    if (area[field] !== undefined && typeof area[field] !== "string") {
      throw new Error(`CAP area ${field} must be text.`);
    }
  }
  if (typeof area.areaDesc !== "string" || !area.areaDesc.trim()) throw new Error("Every CAP area requires areaDesc.");
  if ((area.polygons || []).some(value => typeof value !== "string") ||
      (area.circles || []).some(value => typeof value !== "string")) {
    throw new Error("CAP area polygon and circle entries must be text.");
  }
  const shapes = [...(area.polygons || []), ...(area.circles || [])];
  if (area.polygon) shapes.push(area.polygon);
  if (area.circle) shapes.push(area.circle);
  if (!shapes.length && !(area.geocodes || []).length) throw new Error("Every CAP area requires polygon, circle or geocode geometry.");
  for (const polygon of [...(area.polygons || []), ...(area.polygon ? [area.polygon] : [])]) validatePolygon(polygon);
  for (const circle of [...(area.circles || []), ...(area.circle ? [area.circle] : [])]) {
    const parts = circle.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].split(",").length !== 2) throw new Error("A CAP circle must use 'latitude,longitude radiusKm'.");
    const [lat, lon] = parts[0].split(",").map(decimalNumber), radius = decimalNumber(parts[1]);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(radius) || radius <= 0) {
      throw new Error("CAP circle coordinates or radius are invalid.");
    }
  }
  for (const item of area.geocodes || []) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.valueName !== "string" || !item.valueName.trim() ||
        (typeof item.value !== "string" && typeof item.value !== "number") || !String(item.value).trim()) {
      throw new Error("CAP geocodes require object records with valueName and value.");
    }
  }
  if (area.altitude !== undefined && !isDecimalValue(area.altitude)) throw new Error("CAP altitude must be numeric.");
  if (area.ceiling !== undefined && !isDecimalValue(area.ceiling)) throw new Error("CAP ceiling must be numeric.");
  if (area.altitude !== undefined && area.ceiling !== undefined && Number(area.ceiling) < Number(area.altitude)) throw new Error("CAP ceiling cannot be lower than altitude.");
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
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new Error("Each CAP resource must be an object.");
  }
  if (typeof resource.resourceDesc !== "string" || !resource.resourceDesc.trim() ||
      typeof resource.mimeType !== "string" || !resource.mimeType.trim()) {
    throw new Error("CAP resources require a text resourceDesc and mimeType.");
  }
  if ([...resource.resourceDesc].length > 256) throw new Error("CAP resource description must not exceed 256 characters.");
  if (!/^[!#$%&'*+.^_\`|~0-9A-Za-z-]+\/[!#$%&'*+.^_\`|~0-9A-Za-z-]+$/.test(resource.mimeType)) {
    throw new Error("CAP resource mimeType must be a valid type/subtype media type.");
  }
  const out = { resourceDesc: resource.resourceDesc, mimeType: resource.mimeType.toLowerCase() };
  if (resource.size !== undefined) {
    const sizeText = typeof resource.size === "string" ? resource.size.trim() : resource.size;
    const size = typeof sizeText === "number" ? sizeText : typeof sizeText === "string" && /^\d+$/.test(sizeText) ? Number(sizeText) : NaN;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("CAP resource size must be a non-negative integer.");
    out.size = String(size);
  }
  if (resource.uri !== undefined && resource.uri !== null && resource.uri !== "") {
    if (typeof resource.uri !== "string") throw new Error("CAP resource uri must be text.");
    let parsed;
    try { parsed = new URL(resource.uri); } catch { throw new Error("CAP resource uri must be an absolute HTTP or HTTPS URL."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("CAP resource uri must use HTTP or HTTPS and must not contain embedded credentials.");
    }
    out.uri = parsed.toString();
  }
  if (resource.derefUri !== undefined) {
    if (typeof resource.derefUri !== "string" || !resource.derefUri ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(resource.derefUri) ||
        Buffer.from(resource.derefUri, "base64").toString("base64") !== resource.derefUri ||
        Buffer.byteLength(resource.derefUri, "utf8") > 2_000_000) {
      throw new Error("CAP resource derefUri must be canonical Base64-encoded content up to 2 MB.");
    }
    out.derefUri = resource.derefUri;
  }
  if (resource.digest !== undefined) {
    if (typeof resource.digest !== "string" || !/^[A-Za-z0-9+/]{27}=$/.test(resource.digest) ||
        Buffer.from(resource.digest, "base64").toString("base64") !== resource.digest) {
      throw new Error("CAP resource digest must be a canonical Base64-encoded SHA-1 digest.");
    }
    out.digest = resource.digest;
  }
  return out;
}
function normalizeInfo(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new Error("Each CAP info block must be an object.");
  }
  for (const [field, value] of [
    ["resources", info.resources], ["parameters", info.parameters], ["areas", info.areas],
    ["categories", info.categories], ["response_types", info.response_types]
  ]) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`CAP info ${field} must be an array.`);
    }
  }
  if (typeof info.event !== "string" || !info.event.trim()) throw new Error("Every CAP info block requires an event.");
  for (const [field, values] of [["urgency", allowed.urgency], ["severity", allowed.severity], ["certainty", allowed.certainty]]) {
    if (!values.includes(info[field] || "Unknown")) throw new Error(`Invalid CAP info ${field}.`);
  }
  if (info.language && !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(info.language)) throw new Error("CAP language must use a valid RFC 3066-style language tag.");
  if (info.headline && [...info.headline].length > 160) throw new Error("CAP headline must not exceed 160 characters.");
  if (info.expires && info.onset && Date.parse(info.expires) <= Date.parse(info.onset)) throw new Error("Info expiry must be later than onset.");
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
  if (info.parameters?.length) {
    for (const parameter of info.parameters) {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter) ||
          typeof parameter.valueName !== "string" || !parameter.valueName.trim() ||
          (typeof parameter.value !== "string" && typeof parameter.value !== "number") ||
          !String(parameter.value).trim()) {
        throw new Error("CAP parameters require object records with valueName and a text or numeric value.");
      }
    }
    out.parameter = info.parameters.map(p => ({ valueName: p.valueName, value: p.value }));
  }
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
  // CAP 1.2: Restricted scope requires a restriction description; Private scope requires addresses.
  if (input.scope === "Restricted") {
    if (typeof input.restriction !== "string" || !input.restriction.trim()) {
      throw new Error("CAP Restricted scope requires a non-empty restriction description.");
    }
  }
  if (input.scope === "Private") {
    if (typeof input.addresses !== "string" || !input.addresses.trim()) {
      throw new Error("CAP Private scope requires a non-empty addresses value listing intended recipients.");
    }
  }
  // SQLite returns NULL as null; treat null like an omitted optional field.
  if (input.restriction != null && typeof input.restriction !== "string") {
    throw new Error("CAP restriction must be text.");
  }
  if (input.addresses != null && typeof input.addresses !== "string") {
    throw new Error("CAP addresses must be text.");
  }
  if (["Update","Cancel","Ack","Error"].includes(input.msg_type)) validateReferences(input.references_text);
  capDateTime(input.sent, "sent");
  if (input.info_blocks !== undefined && !Array.isArray(input.info_blocks)) {
    throw new Error("CAP info_blocks must be an array.");
  }
  // An explicit empty info_blocks array means "no blocks" and must not fall back to top-level fields.
  const blocks = Array.isArray(input.info_blocks)
    ? input.info_blocks
    : (["Cancel","Ack","Error"].includes(input.msg_type) ? [] : [{
    language: input.language, category: input.category, event: input.event, urgency: input.urgency,
    severity: input.severity, certainty: input.certainty, effective: input.effective, onset: input.onset,
    expires: input.expires, headline: input.headline, description: input.description,
    instruction: input.instruction, response_type: input.response_type,
    area: { areaDesc: input.area_desc, polygon: input.polygon, circle: input.circle }
  }]);
  if (input.msg_type === "Alert" && !blocks.length) throw new Error("CAP Alert messages require at least one info block.");
  if (input.msg_type !== "Cancel" && input.msg_type !== "Ack" && input.msg_type !== "Error" && !blocks.length) throw new Error("This CAP message type requires an info block.");
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new Error("Each CAP info block must be an object.");
    }
  }
  if (!["Cancel","Ack","Error"].includes(input.msg_type)) {
    for (const block of blocks) if (!(block.areas?.length || block.area)) throw new Error("Each warning info block must identify at least one affected area.");
  }
  blocks.forEach(normalizeInfo);
  if (input.expires && input.onset && Date.parse(input.expires) <= Date.parse(input.onset)) throw new Error("Expiry must be later than onset.");
  return true;
}

export function makeIdentifier() { return `urn:uuid:${randomUUID()}`; }

export function buildCapXml(a) {
  validateAlert(a);
  const infos = Array.isArray(a.info_blocks) ? a.info_blocks : [{
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

/**
 * Parse a CAP 1.2 XML document into the internal alert representation used by validateAlert/buildCapXml.
 * Accepts whitespace and element-order variations produced by xmlbuilder2 and typical receivers.
 */
export function parseCapXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("CAP XML is required");
  let document;
  try {
    document = create(xml).end({ format: "object" });
  } catch {
    throw new Error("CAP XML is not well-formed");
  }
  const alert = document?.alert;
  if (!alert || typeof alert !== "object") throw new Error("CAP XML must contain a root alert element");

  const infoNodes = asArray(alert.info);
  const info_blocks = infoNodes.map(info => {
    const categories = asArray(info.category).map(textValue).filter(Boolean);
    const responseTypes = asArray(info.responseType).map(textValue).filter(Boolean);
    const areas = asArray(info.area).map(area => ({
      areaDesc: textValue(area.areaDesc) || "",
      polygon: textValue(area.polygon) || "",
      circle: textValue(area.circle) || "",
      altitude: textValue(area.altitude),
      ceiling: textValue(area.ceiling),
      geocode: asArray(area.geocode).map(code => ({
        valueName: textValue(code.valueName) || "",
        value: textValue(code.value) || ""
      })).filter(code => code.valueName || code.value)
    }));
    const resources = asArray(info.resource).map(resource => ({
      resourceDesc: textValue(resource.resourceDesc) || "",
      mimeType: textValue(resource.mimeType) || "",
      size: textValue(resource.size),
      uri: textValue(resource.uri) || "",
      derefUri: textValue(resource.derefUri) || "",
      digest: textValue(resource.digest) || ""
    }));
    const parameters = asArray(info.parameter).map(parameter => ({
      valueName: textValue(parameter.valueName) || "",
      value: textValue(parameter.value) || ""
    }));
    return {
      language: textValue(info.language) || "en-US",
      categories: categories.length ? categories : undefined,
      category: categories[0],
      event: textValue(info.event) || "",
      urgency: textValue(info.urgency) || "Unknown",
      severity: textValue(info.severity) || "Unknown",
      certainty: textValue(info.certainty) || "Unknown",
      effective: textValue(info.effective) || "",
      onset: textValue(info.onset) || "",
      expires: textValue(info.expires) || "",
      headline: textValue(info.headline) || "",
      description: textValue(info.description) || "",
      instruction: textValue(info.instruction) || "",
      responseTypes: responseTypes.length ? responseTypes : undefined,
      response_type: responseTypes[0] || "",
      areas,
      resources: resources.length ? resources : undefined,
      parameters: parameters.length ? parameters : undefined
    };
  });

  const first = info_blocks[0] || {};
  const firstArea = first.areas?.[0] || {};
  const parsed = {
    identifier: textValue(alert.identifier) || "",
    sender: textValue(alert.sender) || "",
    sent: textValue(alert.sent) || "",
    status: textValue(alert.status) || "Test",
    msg_type: textValue(alert.msgType) || "Alert",
    scope: textValue(alert.scope) || "Public",
    restriction: textValue(alert.restriction),
    addresses: textValue(alert.addresses),
    references_text: textValue(alert.references) || "",
    note: textValue(alert.note) || "",
    source: textValue(alert.source) || "",
    event: first.event || "",
    category: first.category || "Met",
    urgency: first.urgency || "Unknown",
    severity: first.severity || "Unknown",
    certainty: first.certainty || "Unknown",
    headline: first.headline || "",
    description: first.description || "",
    instruction: first.instruction || "",
    response_type: first.response_type || "",
    effective: first.effective || "",
    onset: first.onset || "",
    expires: first.expires || "",
    language: first.language || "en-US",
    area_desc: firstArea.areaDesc || "",
    polygon: firstArea.polygon || "",
    circle: firstArea.circle || "",
    info_blocks: ["Cancel", "Ack", "Error"].includes(textValue(alert.msgType) || "Alert") ? [] : info_blocks
  };
  validateAlert(parsed);
  return parsed;
}

/** Export then re-import a CAP message and return both representations for interoperability checks. */
export function roundTripCap(input) {
  const xml = buildCapXml(input);
  const parsed = parseCapXml(xml);
  const xmlAgain = buildCapXml(parsed);
  return { xml, parsed, xmlAgain };
}
