/**
 * Independent CAP receiver B — DOM-like parse via xmlbuilder2 object mode only.
 * Intentionally separate from application validateAlert pipeline.
 */
import { create } from "xmlbuilder2";

function text(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && node["#"] != null) return String(node["#"]);
  return "";
}

export function receiveCapXmlB(xml) {
  let doc;
  try {
    doc = create(xml).end({ format: "object" });
  } catch {
    return { ok: false, error: "malformed xml", kind: "Error" };
  }
  const alert = doc?.alert;
  if (!alert) return { ok: false, error: "missing alert", kind: "Error" };
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
  if (["Update", "Cancel", "Ack", "Error"].includes(msgType) && !references) {
    return { ok: false, error: "references required", kind: "Error" };
  }
  if (scope === "Restricted" && !restriction.trim()) {
    return { ok: false, error: "restriction required", kind: "Error" };
  }
  if (scope === "Private" && !addresses.trim()) {
    return { ok: false, error: "addresses required", kind: "Error" };
  }
  // Unicode / Arabic presence is accepted as opaque text.
  const headline = text(alert.info?.headline) || text(Array.isArray(alert.info) ? alert.info[0]?.headline : "");
  return {
    ok: true,
    stored: { identifier, sender, sent, msgType, scope, status, references, restriction, addresses, headline },
    ack: { msgType: "Ack", references: `${sender},${identifier},${sent}`, note: "receiver-b accepted" }
  };
}
