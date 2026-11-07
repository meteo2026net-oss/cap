/**
 * Independent CAP receiver A — minimal tag extraction (not using src/cap.js).
 * Local simulation only; no network listeners.
 */
function extract(tag, xml) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(re);
  return match ? match[1].trim() : "";
}

export function receiveCapXmlA(xml) {
  if (typeof xml !== "string" || !xml.includes("<alert")) {
    return { ok: false, error: "missing alert root", kind: "Error" };
  }
  const msgType = extract("msgType", xml);
  const identifier = extract("identifier", xml);
  const sender = extract("sender", xml);
  const sent = extract("sent", xml);
  const scope = extract("scope", xml);
  const references = extract("references", xml);
  const status = extract("status", xml);
  if (!identifier || !sender || !sent || !msgType || !scope || !status) {
    return { ok: false, error: "missing required CAP header fields", kind: "Error", identifier, sender };
  }
  if (!["Alert", "Update", "Cancel", "Ack", "Error"].includes(msgType)) {
    return { ok: false, error: "unsupported msgType", kind: "Error", identifier, sender };
  }
  if (["Update", "Cancel", "Ack", "Error"].includes(msgType) && !references) {
    return { ok: false, error: "derived message missing references", kind: "Error", identifier, sender };
  }
  if (scope === "Restricted" && !extract("restriction", xml)) {
    return { ok: false, error: "Restricted requires restriction", kind: "Error", identifier, sender };
  }
  if (scope === "Private" && !extract("addresses", xml)) {
    return { ok: false, error: "Private requires addresses", kind: "Error", identifier, sender };
  }
  return {
    ok: true,
    stored: { identifier, sender, sent, msgType, scope, status, references },
    ack: {
      msgType: "Ack",
      references: `${sender},${identifier},${sent}`,
      note: "receiver-a accepted"
    }
  };
}
