"""Parse KML into GeoJSON FeatureCollection for headless TIF export."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

KML_NS = "http://www.opengis.net/kml/2.2"
GX_NS = "http://www.google.com/kml/ext/2.2"
NS = {"kml": KML_NS, "gx": GX_NS}


class KmlParseError(ValueError):
    pass


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find(parent: ET.Element, name: str) -> ET.Element | None:
    el = parent.find(f"kml:{name}", NS)
    if el is not None:
        return el
    for child in parent:
        if _local(child.tag) == name:
            return child
    return None


def _findall(parent: ET.Element, name: str) -> list[ET.Element]:
    found = list(parent.findall(f"kml:{name}", NS))
    if found:
        return found
    return [child for child in parent if _local(child.tag) == name]


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    value = el.text.strip()
    return value if value else None


def _kml_color_to_rgba(color: str | None) -> dict[str, Any] | None:
    if not color:
        return None
    raw = color.strip().lstrip("#").lower()
    if not re.fullmatch(r"[0-9a-f]{6}([0-9a-f]{2})?", raw):
        return None
    if len(raw) == 8:
        aa = int(raw[0:2], 16) / 255.0
        bb = int(raw[2:4], 16)
        gg = int(raw[4:6], 16)
        rr = int(raw[6:8], 16)
    else:
        aa = 1.0
        rr = int(raw[0:2], 16)
        gg = int(raw[2:4], 16)
        bb = int(raw[4:6], 16)
    return {
        "hex": f"#{rr:02x}{gg:02x}{bb:02x}",
        "opacity": round(aa, 3),
    }


def _parse_coords(text: str | None) -> list[list[float]] | None:
    if not text:
        return None
    coords: list[list[float]] = []
    for token in text.split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        coords.append([lon, lat])
    return coords or None


def _ring_coords(el: ET.Element) -> list[list[float]] | None:
    ring = _find(el, "outerBoundaryIs")
    if ring is not None:
        ring = _find(ring, "LinearRing")
    if ring is None:
        ring = _find(el, "LinearRing")
    if ring is None:
        return None
    return _parse_coords(_text(_find(ring, "coordinates")))


def _line_coords(el: ET.Element) -> list[list[float]] | None:
    return _parse_coords(_text(_find(el, "coordinates")))


def _geometry_from_element(el: ET.Element) -> dict[str, Any] | None:
    tag = _local(el.tag)
    if tag == "Point":
        c = _parse_coords(_text(_find(el, "coordinates")))
        if not c:
            return None
        return {"type": "Point", "coordinates": c[0]}
    if tag == "LineString":
        c = _line_coords(el)
        if not c:
            return None
        return {"type": "LineString", "coordinates": c}
    if tag == "LinearRing":
        c = _line_coords(el)
        if not c:
            return None
        if c[0] != c[-1]:
            c.append(c[0])
        return {"type": "Polygon", "coordinates": [c]}
    if tag == "Polygon":
        outer = _ring_coords(el)
        if not outer:
            return None
        rings = [outer]
        for inner in _findall(el, "innerBoundaryIs"):
            inner_ring = _find(inner, "LinearRing")
            if inner_ring is None:
                continue
            inner_coords = _parse_coords(_text(_find(inner_ring, "coordinates")))
            if inner_coords:
                rings.append(inner_coords)
        return {"type": "Polygon", "coordinates": rings}
    if tag == "MultiGeometry":
        parts: list[dict[str, Any]] = []
        for child in el:
            geom = _geometry_from_element(child)
            if geom:
                if geom["type"] == "GeometryCollection":
                    parts.extend(geom["geometries"])
                else:
                    parts.append(geom)
        if not parts:
            return None
        if len(parts) == 1:
            return parts[0]
        return {"type": "GeometryCollection", "geometries": parts}
    return None


def _style_props(style_el: ET.Element | None) -> dict[str, Any]:
    props: dict[str, Any] = {}
    if style_el is None:
        return props
    line = _find(style_el, "LineStyle")
    if line is not None:
        color = _kml_color_to_rgba(_text(_find(line, "color")))
        if color:
            props["stroke"] = color["hex"]
            props["strokeOpacity"] = color["opacity"]
        width = _text(_find(line, "width"))
        if width:
            try:
                props["strokeWidth"] = float(width)
            except ValueError:
                pass
    poly = _find(style_el, "PolyStyle")
    if poly is not None:
        color = _kml_color_to_rgba(_text(_find(poly, "color")))
        if color:
            props["fill"] = color["hex"]
            props["fillOpacity"] = color["opacity"]
        fill = _text(_find(poly, "fill"))
        if fill == "0":
            props["fillOpacity"] = 0
    return props


def _collect_styles(root: ET.Element) -> dict[str, dict[str, Any]]:
    styles: dict[str, dict[str, Any]] = {}
    for style in root.iter():
        if _local(style.tag) != "Style":
            continue
        style_id = style.get("id")
        if not style_id:
            continue
        styles[f"#{style_id}"] = _style_props(style)
    for style_map in root.iter():
        if _local(style_map.tag) != "StyleMap":
            continue
        style_id = style_map.get("id")
        if not style_id:
            continue
        normal_url = None
        for pair in _findall(style_map, "Pair"):
            key = _text(_find(pair, "key"))
            if key == "normal":
                normal_url = _text(_find(pair, "styleUrl"))
                break
        if normal_url and normal_url in styles:
            styles[f"#{style_id}"] = styles[normal_url]
    return styles


def _placemark_feature(pm: ET.Element, styles: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    name = _text(_find(pm, "name"))
    description = _text(_find(pm, "description"))
    style_url = _text(_find(pm, "styleUrl"))
    style_props = styles.get(style_url or "", {}) if style_url else {}

    geom_el = None
    for child in pm:
        local = _local(child.tag)
        if local in ("Point", "LineString", "LinearRing", "Polygon", "MultiGeometry"):
            geom_el = child
            break
    if geom_el is None:
        return []

    geometry = _geometry_from_element(geom_el)
    if not geometry:
        return []

    base_props = {
        "name": name or "Unnamed",
        "description": description,
        **style_props,
    }

    features: list[dict[str, Any]] = []

    def add_feature(geom: dict[str, Any], suffix: str = "") -> None:
        props = {**base_props}
        if suffix:
            props["name"] = f"{base_props['name']} ({suffix})"
        features.append({"type": "Feature", "properties": props, "geometry": geom})

    if geometry["type"] == "GeometryCollection":
        for idx, geom in enumerate(geometry["geometries"], start=1):
            add_feature(geom, str(idx))
    else:
        add_feature(geometry)

    return features


def _walk(container: ET.Element, styles: dict[str, dict[str, Any]], out: list[dict[str, Any]]) -> None:
    for pm in _findall(container, "Placemark"):
        out.extend(_placemark_feature(pm, styles))
    for folder in _findall(container, "Folder") + _findall(container, "Document"):
        _walk(folder, styles, out)


def parse_kml(content: bytes) -> dict[str, Any]:
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise KmlParseError(f"Invalid XML: {exc}") from exc

    kml_root = root
    if _local(root.tag) != "kml":
        kml = _find(root, "kml")
        if kml is not None:
            kml_root = kml

    styles = _collect_styles(kml_root)
    features: list[dict[str, Any]] = []
    _walk(kml_root, styles, features)

    if not features:
        raise KmlParseError("No map features found in KML (expected Placemark polygons or lines).")

    doc_name = None
    for doc in _findall(kml_root, "Document"):
        doc_name = _text(_find(doc, "name"))
        if doc_name:
            break

    return {
        "type": "FeatureCollection",
        "name": doc_name,
        "features": features,
    }


def _bbox_area(coords) -> float:
    """Rough geographic bbox area (deg²) for stacking order; not geodesic."""
    lons: list[float] = []
    lats: list[float] = []

    def walk(c):
        if not isinstance(c, (list, tuple)) or not c:
            return
        if isinstance(c[0], (int, float)) and len(c) >= 2 and isinstance(c[1], (int, float)):
            lons.append(float(c[0]))
            lats.append(float(c[1]))
            return
        for item in c:
            walk(item)

    walk(coords)
    if not lons or not lats:
        return 0.0
    return max(0.0, (max(lons) - min(lons)) * (max(lats) - min(lats)))


def _feature_sort_area(feature: dict[str, Any]) -> float:
    geom = feature.get("geometry") or {}
    gtype = geom.get("type") or ""
    if "Point" in gtype:
        return -1.0
    if "Line" in gtype:
        return 0.0
    if gtype == "GeometryCollection":
        return sum(_feature_sort_area({"geometry": g}) for g in geom.get("geometries") or [])
    return _bbox_area(geom.get("coordinates"))


def prepare_kml_export_layers(layers: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """
    Convert DB KML rows into GeoJSON payloads for headless Leaflet.
    Each input item: {name, content, color, opacity}
    """
    out: list[dict[str, Any]] = []
    for raw in layers or []:
        content = raw.get("content")
        if not content:
            continue
        try:
            if isinstance(content, str):
                fc = parse_kml(content.encode("utf-8"))
            else:
                fc = parse_kml(content)
        except (KmlParseError, Exception):
            continue
        features = []
        for feat in fc.get("features") or []:
            if not feat or not feat.get("geometry"):
                continue
            props = dict(feat.get("properties") or {})
            props["_sortArea"] = _feature_sort_area(feat)
            features.append({"type": "Feature", "properties": props, "geometry": feat["geometry"]})
        # Largest polygons first so Leaflet draws smaller ones on top.
        features.sort(
            key=lambda f: (
                0
                if "Polygon" in ((f.get("geometry") or {}).get("type") or "")
                or (f.get("geometry") or {}).get("type") == "GeometryCollection"
                else 1
                if "Line" in ((f.get("geometry") or {}).get("type") or "")
                else 2,
                -float((f.get("properties") or {}).get("_sortArea") or 0),
            )
        )
        if not features:
            continue
        color = raw.get("color") or "#4de2ff"
        try:
            opacity = float(raw.get("opacity", 0.65))
        except (TypeError, ValueError):
            opacity = 0.65
        opacity = max(0.0, min(1.0, opacity))
        out.append(
            {
                "name": raw.get("name") or fc.get("name") or "KML",
                "color": color,
                "opacity": opacity,
                "geojson": {"type": "FeatureCollection", "features": features},
            }
        )
    return out

