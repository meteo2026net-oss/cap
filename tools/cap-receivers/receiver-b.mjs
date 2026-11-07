/**
 * Independent local CAP receiver B.
 * Uses xmlbuilder2 object conversion and its own CAP field policy.
 * Local simulation only; no network listeners or external delivery.
 */
import { create } from "xmlbuilder2";
import { persistReceiverMessage } from "./receiver-store.mjs";

const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
const DERIVED_TYPES = ["Update", "Cancel", "Ack", "Error"];

function text(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (typeof node === "object" && node["#"] != null) return String(node["#"]).trim();
  return "";
}

function readAlert(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("CAP XML is required");
  if (Buffer.byteLength(xml, "utf8") > 1_000_000) throw new Error("CAP XML exceeds the 1 MB receiver limit");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("DTD and entity declarations are not accepted");
  let root;
  try {
    root = create(xml).end({ format: "object" });
  } catch {
    throw new Error("malformed xml");
  }
  const alert = root?.alert;
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) throw new Error("missing alert");
  if (alert["@xmlns"] && alert["@xmlns"] !== CAP_NAMESPACE) throw new Error("unexpected CAP namespace");
  return alert;
}

function referencesExist(referenceText, history) {
  const triplets = referenceText.split(/\s+/).filter(Boolean);
  if (!triplets.length) return false;
  if (!Array.isArray(history)) return false;
  return triplets.every(value => {
    const tuple = value.split(",");
    if (tuple.length !== 3 || tuple.some(part => !part)) return false;
    const [sender, identifier, sent] = tuple;
    return history.some(item => item.sender === sender && item.identifier === identifier && item.sent === sent);
  });
}

export function receiveCapXmlB(xml, { knownMessages = [], database = null } = {}) {
  let alert;
  try {
    alert = readAlert(xml);
  } catch (error) {
    return { ok: false, error: error.message, kind: "Error" };
  }
  const identifier = text(alert.identifier);
  const sender = text(alert.sender);
  const sent = text(alert.sent);
  const msgType = text(alert.msgType);
  const scope = text(alert.scope);
  const status = text(alert.status);
  const references = text(alert.references);
  const restriction = text(alert.restriction);
  const addresses = text(alert.addresses);
  if (!identifier || !sender || !sent || !msgType || !scope || !status) {
    return { ok: false, error: "missing required fields", kind: "Error" };
  }
  if (!["Alert", ...DERIVED_TYPES].includes(msgType)) return { ok: false, error: "unsupported msgType", kind: "Error" };
  if (!["Public", "Restricted", "Private"].includes(scope)) return { ok: false, error: "unsupported scope", kind: "Error" };
  if (!["Actual", "Exercise", "System", "Test"].includes(status)) return { ok: false, error: "unsupported status", kind: "Error" };
  if (scope === "Restricted" && !restriction) return { ok: false, error: "restriction required", kind: "Error" };
  if (scope === "Private" && !addresses) return { ok: false, error: "addresses required", kind: "Error" };
  const infoNodes = alert.info == null ? [] : Array.isArray(alert.info) ? alert.info : [alert.info];
  const headline = infoNodes.map(info => text(info?.headline)).find(Boolean) || "";
  return {
    ok: true,
    duplicate,
    stored: { ...stored, headline },
    ack: { msgType: "Ack", references: `${sender},${identifier},${sent}`, note: "receiver-b accepted" }
  };
}
