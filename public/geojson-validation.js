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
  const geometry = (value, depth = 0) => {
    if (depth > 8) throw new Error("تداخل GeometryCollection يتجاوز الحد المسموح.");
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
        value.geometries.forEach(child => geometry(child, depth + 1)); break;
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
    const id = typeof feature.id === "string" ? feature.id.slice(0, 128) : feature.id;
    return { type: "Feature", ...(feature.id === undefined ? {} : { id }), geometry: feature.geometry, properties };
  });
  return { type: "FeatureCollection", features };
}

export function polygonLatLngsToCap(points) {
  if (!Array.isArray(points) || points.length < 3) throw new Error("يجب أن يحتوي المضلع على ثلاث نقاط على الأقل.");
  const coords = points.map(point => {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng) ||
        Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      throw new Error("إحداثيات المضلع المرسوم غير صالحة.");
    }
    return point.lat.toFixed(6) + "," + point.lng.toFixed(6);
  });
  if (coords[0] !== coords[coords.length - 1]) coords.push(coords[0]);
  return coords.join(" ");
}

export function circleToCap(latitude, longitude, radiusMeters) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
      !Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 1000000) {
    throw new Error("مركز الدائرة أو نصف قطرها غير صالح.");
  }
  return latitude.toFixed(6) + "," + longitude.toFixed(6) + " " + (radiusMeters / 1000).toFixed(2);
}

if (typeof window !== "undefined") {
  window.validateImportedGeoJSON = validateImportedGeoJSON;
  window.polygonLatLngsToCap = polygonLatLngsToCap;
  window.circleToCap = circleToCap;
}
