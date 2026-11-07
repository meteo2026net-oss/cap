/**
 * Independent local CAP receiver A.
 * Parses XML with an XML parser; it does not call the application CAP parser.
 * Local simulation only; no network listeners or external delivery.
 */
import { create } from "xmlbuilder2";

const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
const DERIVED_TYPES = new Set(["Update", "Cancel", "Ack", "Error"]);

function nodeText(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (typeof node === "object" && node["#"] != null) return String(node["#"]).trim();
  return "";
}

function parseDocument(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("CAP XML is required");
  if (Buffer.byteLength(xml, "utf8") > 1_000_000) throw new Error("CAP XML exceeds the 1 MB receiver limit");
  // This receiver has no need for DTDs or entities; reject them before parsing.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("DTD and entity declarations are not accepted");
  let document;
  try {
    document = create(xml).end({ format: "object" });
  } catch {
    throw new Error("malformed XML");
  }
  const alert = document?.alert;
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) throw new Error("missing CAP alert root");
  if (alert["@xmlns"] && alert["@xmlns"] !== CAP_NAMESPACE) throw new Error("unexpected CAP namespace");
  return alert;
}

function verifyReferences(referencesText, knownMessages) {
  const references = referencesText.trim().split(/\s+/).filter(Boolean);
  if (!references.length) return { ok: false, error: "derived message missing references" };
  if (!Array.isArray(knownMessages)) return { ok: false, error: "known message history must be an array" };
  for (const reference of references) {
    const parts = reference.split(",");
    if (parts.length !== 3 || parts.some(part => !part)) return { ok: false, error: "invalid CAP reference triplet" };
    const [sender, identifier, sent] = parts;
    const found = knownMessages.some(message =>
      message.sender === sender && message.identifier === identifier && message.sent === sent
    );
    if (!found) return { ok: false, error: "referenced CAP message is not present or does not match sender/identifier/sent" };
  }
  return { ok: true };
}

export function receiveCapXmlA(xml, knownMessages = []) {
  let alert;
  try {
    alert = parseDocument(xml);
  } catch (error) {
    return { ok: false, error: error.message, kind: "Error" };
  }
  const stored = {
    identifier: nodeText(alert.identifier),
    sender: nodeText(alert.sender),
    sent: nodeText(alert.sent),
    msgType: nodeText(alert.msgType),
    scope: nodeText(alert.scope),
    status: nodeText(alert.status),
    references: nodeText(alert.references)
  };
  if (Object.values(stored).slice(0, 6).some(value => !value)) {
    return { ok: false, error: "missing required CAP header fields", kind: "Error", stored };
  }
  if (!["Alert", "Update", "Cancel", "Ack", "Error"].includes(stored.msgType)) {
    return { ok: false, error: "unsupported msgType", kind: "Error", stored };
  }
  if (!["Public", "Restricted", "Private"].includes(stored.scope)) {
    return { ok: false, error: "unsupported scope", kind: "Error", stored };
  }
  if (!["Actual", "Exercise", "System", "Test"].includes(stored.status)) {
    return { ok: false, error: "unsupported status", kind: "Error", stored };
  }
  if (DERIVED_TYPES.has(stored.msgType)) {
    const checked = verifyReferences(stored.references, knownMessages);
    if (!checked.ok) return { ok: false, error: checked.error, kind: "Error", stored };
  }
  if (stored.scope === "Restricted" && !nodeText(alert.restriction)) {
    return { ok: false, error: "Restricted requires restriction", kind: "Error", stored };
  }
  if (stored.scope === "Private" && !nodeText(alert.addresses)) {
    return { ok: false, error: "Private requires addresses", kind: "Error", stored };
  }
  return {
    ok: true,
    stored,
    ack: { msgType: "Ack", references: `${stored.sender},${stored.identifier},${stored.sent}`, note: "receiver-a accepted" }
  };
}
