// source_code/frontend/config.prod.js - Production Configuration
export const SHOW_ATTRIBUTION = true; // Show attributions in production

// Production API base URL - update this to your deployed backend URL
const API_BASE_URL = window.location.origin.includes('localhost')
  ? 'http://127.0.0.1:5001'  // Development fallback
  : '/api';  // Production: assumes backend is served from same domain at /api

export const API_ENDPOINTS = {
  login: `${API_BASE_URL}/auth/login`,
  me: `${API_BASE_URL}/auth/me`,
  export: `${API_BASE_URL}/export`,
  exportHeadless: `${API_BASE_URL}/export-headless`,
  adminUsers: `${API_BASE_URL}/admin/users`,
  adminStats: `${API_BASE_URL}/admin/stats`,
  userStats: `${API_BASE_URL}/user/stats`,
  tiles: {
    shom: `${API_BASE_URL}/tiles/shom`,
    arcgis: `${API_BASE_URL}/tiles/arcgis`,
    openaip: `${API_BASE_URL}/tiles/openaip`,
    ukho: `${API_BASE_URL}/tiles/ukho`
  }
};

export const LAYERS = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? '&copy; OpenStreetMap contributors' : '',
    names: true
  },
  esri: {
    // Use backend proxy to keep API key server-side (if configured)
    url: `${API_ENDPOINTS.tiles.arcgis}/{z}/{x}/{y}.png?service=World_Imagery`,
    attribution: SHOW_ATTRIBUTION ? 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics' : '',
    names: false
  },
  shom: {
    // Use backend proxy to ensure proper headers
    url: `${API_ENDPOINTS.tiles.shom}/{z}/{x}/{y}.png`,
    attribution: SHOW_ATTRIBUTION ? 'Charts &copy; SHOM' : '',
    names: true
  },
  gbsouth: {
    url: '/tiles/gbsouth/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Rogers data 500k GB south' : '',
    names: true
  },
  ukho: {
    url: `${API_ENDPOINTS.tiles.ukho}/{z}/{x}/{y}.png`,
    attribution: SHOW_ATTRIBUTION ? 'Charts derived from UKHO data' : '',
    names: true
  },
  openseamap: {
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    attribution: SHOW_ATTRIBUTION ? 'Seamarks &copy; OpenSeaMap contributors' : ''
  },
  openaip: {
    // Use backend proxy for API key management
    url: `${API_ENDPOINTS.tiles.openaip}/{z}/{x}/{y}.png`,
    attribution: SHOW_ATTRIBUTION ? '&copy; openAIP' : ''
  },
  density: {
    // Population density overlay using ONS Census 2021 vector tiles
    sources: {
      lad: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/authorities-ew/v2/boundaries/{z}/{x}/{y}.pbf',
      msoa: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/msoa/v2/boundaries/{z}/{x}/{y}.pbf',
      oa: 'https://cdn.ons.gov.uk/maptiles/administrative/2021/oa/v2/boundaries/{z}/{x}/{y}.pbf'
    },
    dataUrl: '/data',
    attribution: SHOW_ATTRIBUTION ? 'Census 2021 &copy; ONS' : ''
  },
  names_overlay: {
    // Place names over satellite imagery (vector imagery/labels + raster fallback)
    styleUrl: '/api/arcgis/style/arcgis/imagery/labels',
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: SHOW_ATTRIBUTION ? 'Labels &copy; Esri' : ''
  }
};

// Production settings
export const CONFIG = {
  // Map settings
  DEFAULT_CENTER: [50.9585, 0.9325],
  DEFAULT_ZOOM: 15,
  MAX_ZOOM: 20,

  // Export settings
  MAX_EXPORT_WIDTH: 4096,
  MAX_EXPORT_HEIGHT: 4096,
  DEFAULT_EXPORT_WIDTH: 1024,

  // UI settings
  ENABLE_DEBUG: false,
  AUTO_REFRESH_PERMISSIONS: true,

  // Security
  TOKEN_STORAGE_KEY: 'scepmaps_token',
  USER_STORAGE_KEY: 'scepmaps_user'
};
