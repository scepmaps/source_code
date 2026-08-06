// source_code/frontend/config.js
export const SHOW_ATTRIBUTION = true; // change to false to hide

// API keys are kept server-side for security
// Frontend uses backend proxy endpoints that add the API keys server-side

export const LAYERS = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? '&copy; OpenStreetMap contributors' : '',
    names: true
  },
  dark: {
    // OSM data rendered in a dark palette (CARTO Dark Matter) — distinct from the ArcGIS "night" style.
    // Split into base + labels so we can brighten names without washing out the map.
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    baseUrl: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    labelsUrl: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; <a href="https://carto.com/attributions">CARTO</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' : '',
    names: true
  },
  esri: {
    // Use backend proxy to keep API key server-side (if configured)
    // Backend adds API key as ?token=... query parameter in URL, NOT in headers
    // World_Imagery base layer
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?service=World_Imagery'
      : '/tiles/arcgis/{z}/{x}/{y}.png?service=World_Imagery',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics' : '',
    names: false
  },
  topo: {
    // ArcGIS Topographic - Vector tile basemap (MapLibre GL compatible)
    // Uses ArcGIS Basemap Styles API to get style JSON
    // Backend proxy adds API key and returns style JSON
    styleUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/api/arcgis/style/arcgis/topographic'
      : '/api/arcgis/style/arcgis/topographic',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, USGS, NPS' : '',
    type: 'vector', // Indicates this is a vector tile layer, not raster
    names: true
  },
  navigation: {
    // ArcGIS Navigation - Vector tile basemap (MapLibre GL compatible)
    // Uses ArcGIS Basemap Styles API to get style JSON
    // Backend proxy adds API key and returns style JSON
    styleUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/api/arcgis/style/arcgis/navigation'
      : '/api/arcgis/style/arcgis/navigation',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA' : '',
    type: 'vector', // Indicates this is a vector tile layer, not raster
    names: true
  },
  night: {
    // ArcGIS Streets Night - Vector tile basemap (MapLibre GL compatible)
    // Uses ArcGIS Basemap Styles API to get style JSON
    // Backend proxy adds API key and returns style JSON
    styleUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/api/arcgis/style/arcgis/streets-night'
      : '/api/arcgis/style/arcgis/streets-night',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, USGS, NGA' : '',
    type: 'vector', // Indicates this is a vector tile layer, not raster
    names: true
  },
  ocean: {
    // Open Basemaps Navigation Dark - Vector tile basemap (MapLibre GL compatible)
    // Uses ArcGIS Basemap Styles API to get style JSON
    // Backend proxy adds API key and returns style JSON
    styleUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/api/arcgis/style/open/navigation-dark'
      : '/api/arcgis/style/open/navigation-dark',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, OSM, Natural Earth' : '',
    type: 'vector', // Indicates this is a vector tile layer, not raster
    names: true
  },
  shom: {
    // Always go through backend proxy so Referer header is set correctly
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/shom/{z}/{x}/{y}.png'
      : '/tiles/shom/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Charts &copy; SHOM' : '',
    names: true
  },
  gbsouth: {
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/gbsouth/{z}/{x}/{y}.png'
      : '/tiles/gbsouth/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Rogers data 500k GB south' : '',
    names: true
  },
  ukho: {
    // UKHO-derived nautical charts via backend WMS tile proxy
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/ukho/{z}/{x}/{y}.png'
      : '/tiles/ukho/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Charts derived from UKHO data' : '',
    names: true
  },
  names_overlay: {
    // Place names over satellite imagery.
    // Prefer ArcGIS Imagery Labels (vector) — designed for World Imagery contrast.
    // Raster fallback uses the standard (non-Alternate) boundaries/places tiles.
    styleUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/api/arcgis/style/arcgis/imagery/labels'
      : '/api/arcgis/style/arcgis/imagery/labels',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: SHOW_ATTRIBUTION ? 'Labels &copy; Esri' : ''
  },
  openseamap: {
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Seamarks &copy; OpenSeaMap contributors' : ''
  },
  openaip: {
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? `http://127.0.0.1:5001/tiles/openaip/{z}/{x}/{y}.png`
      : `/tiles/openaip/{z}/{x}/{y}.png`,
    attribution: SHOW_ATTRIBUTION ? '&copy; openAIP' : ''
  },
  density: {
    // Population density overlay using ONS Census 2021 vector tiles
    sources: {
      lad: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/authorities-ew/v2/boundaries/{z}/{x}/{y}.pbf',
      msoa: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/msoa/v2/boundaries/{z}/{x}/{y}.pbf',
      oa: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/oa/v2/boundaries/{z}/{x}/{y}.pbf'
    },
    dataUrl: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/data'
      : '/data',
    attribution: SHOW_ATTRIBUTION ? 'Census 2021 &copy; ONS' : ''
  },
  // Labeled versions of base maps (composite: base + labels/overlays)
  // Backend adds API key as ?token=... query parameter in URL, NOT in headers
  osm_labeled: {
    // ArcGIS World_Street_Map - Street map with labels (similar to OSM but with labels)
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?service=World_Street_Map'
      : '/tiles/arcgis/{z}/{x}/{y}.png?service=World_Street_Map',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, FAO, NOAA, USGS' : ''
  },
  esri_labeled: {
    // World_Imagery (base) + World_Boundaries_and_Places (labels overlay)
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?service=World_Imagery&composite=Reference/World_Boundaries_and_Places'
      : '/tiles/arcgis/{z}/{x}/{y}.png?service=World_Imagery&composite=Reference/World_Boundaries_and_Places',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics' : ''
  },
  topo_labeled: {
    // World_Topo_Map (base) + World_Hillshade (hillshade overlay)
    url: (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
      ? 'http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?service=World_Topo_Map&composite=World_Hillshade'
      : '/tiles/arcgis/{z}/{x}/{y}.png?service=World_Topo_Map&composite=World_Hillshade',
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, USGS, NPS' : ''
  }
};
