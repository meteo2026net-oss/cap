const MAX_FEATURES = 5000;
const MAX_POSITIONS = 100000;
const SAFE_PROPERTIES = new Set([
  "name", "title", "headline", "event", "description", "area_description",
  "severity", "urgency", "certainty", "sent", "identifier", "language"
]);

export function validateImportedGeoJSON(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      input.type !== "FeatureCollection" || !Array.isArray(input.features)) {
    throw new Error("يجب أن يكون الملف GeoJSON من نوع FeatureCollection.");
  }
  if (input.features.length > MAX_FEATURES) {
    throw new Error("يحتوي الملف على أكثر من 5000 معلم؛ قسّمه إلى ملفات أصغر للمعاينة.");
  }

  let positions = 0;
  const position = value => {
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3) ||
        !value.every(Number.isFinite) || Math.abs(value[0]) > 180 ||
        Math.abs(value[1]) > 90 || (value.length === 3 && Math.abs(value[2]) > 1000000)) {
      throw new Error("إحداثيات GeoJSON غير صالحة أو خارج النطاق الجغرافي.");
    }
    if (++positions > MAX_POSITIONS) throw new Error("يتجاوز الملف الحد الأقصى البالغ 100000 نقطة إحداثية.");
  };
  const line = value => {
    if (!Array.isArray(value) || value.length < 2) throw new Error("يجب أن يحتوي المسار على نقطتين على الأقل.");
    value.forEach(position);
  };
  const ring = value => {
    if (!Array.isArray(value) || value.length < 4) throw new Error("مضلع GeoJSON يحتاج إلى أربع نقاط على الأقل.");
    value.forEach(position);
    const first = value[0], last = value[value.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) throw new Error("حلقة المضلع غير مغلقة.");
  };
  const geometry = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("هندسة GeoJSON مفقودة.");
    const c = value.coordinates;
    switch (value.type) {
      case "Point": position(c); break;
      case "MultiPoint":
        if (!Array.isArray(c) || !c.length) throw new Error("MultiPoint فارغ.");
        c.forEach(position); break;
      case "LineString": line(c); break;
      case "MultiLineString":
        if (!Array.isArray(c) || !c.length) throw new Error("MultiLineString فارغ.");
        c.forEach(line); break;
      case "Polygon":
        if (!Array.isArray(c) || !c.length) throw new Error("Polygon بلا حلقات.");
        c.forEach(ring); break;
      case "MultiPolygon":
        if (!Array.isArray(c) || !c.length) throw new Error("MultiPolygon فارغ.");
        c.forEach(poly => {
          if (!Array.isArray(poly) || !poly.length) throw new Error("مضلع متعدد بلا حلقات.");
          poly.forEach(ring);
        }); break;
      case "GeometryCollection":
        if (!Array.isArray(value.geometries) || !value.geometries.length) throw new Error("GeometryCollection فارغ.");
        value.geometries.forEach(geometry); break;
      default: throw new Error("نوع هندسة GeoJSON غير مدعوم.");
    }
  };

  const features = input.features.map(feature => {
    if (!feature || typeof feature !== "object" || Array.isArray(feature) || feature.type !== "Feature") {
      throw new Error("يحتوي الملف على عنصر ليس Feature صالحاً.");
    }
    geometry(feature.geometry);
    const source = feature.properties && typeof feature.properties === "object" &&
      !Array.isArray(feature.properties) ? feature.properties : {};
    const properties = {};
    for (const key of SAFE_PROPERTIES) {
      const value = source[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        properties[key] = String(value).slice(0, 500);
      }
    }
    if (feature.id !== undefined && !["string", "number"].includes(typeof feature.id)) {
      throw new Error("معرّف Feature يجب أن يكون نصاً أو رقماً.");
    }
    return { type: "Feature", ...(feature.id === undefined ? {} : { id: feature.id }), geometry: feature.geometry, properties };
  });
  return { type: "FeatureCollection", features };
}

if (typeof window !== "undefined") window.validateImportedGeoJSON = validateImportedGeoJSON;
