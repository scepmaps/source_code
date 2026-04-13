"""
Label scaling utility for ArcGIS maps.

Since ArcGIS tiles are raster images, we can't directly modify label sizes.
Instead, we use CSS filters and image rendering techniques to enhance label
readability, and optionally request tiles at a slightly higher zoom level
to make labels appear larger relative to the map.
"""

def get_label_enhancement_css(zoom: int) -> str:
    """
    Generate CSS to enhance label readability on ArcGIS map tiles.
    
    Uses CSS filters and image rendering to make labels appear bolder
    and more readable, with zoom-level adaptive settings.
    
    Args:
        zoom: Current zoom level (0-20)
    
    Returns:
        CSS string to inject into the page
    """
    # Adaptive filter strength based on zoom level
    # Lower zoom = stronger enhancement (labels are smaller and harder to read)
    if zoom <= 5:
        contrast = 1.15  # Strong contrast boost at low zoom
        brightness = 1.08
        sharpness = 1.2
    elif zoom <= 10:
        contrast = 1.10  # Moderate enhancement at medium zoom
        brightness = 1.05
        sharpness = 1.1
    else:
        contrast = 1.05  # Subtle enhancement at high zoom
        brightness = 1.02
        sharpness = 1.05
    
    css = f"""
    <style id="arcgis-label-enhancer">
    /* Enhance label readability in ArcGIS raster tiles */
    .leaflet-tile-container img[src*="arcgis"],
    .leaflet-tile-container img[src*="static-map-tiles"],
    .leaflet-tile-container img[src*="ibasemaps-api"] {{
        /* Enhance contrast to make labels stand out more */
        filter: contrast({contrast}) brightness({brightness});
        
        /* Use crisp rendering to prevent label blur */
        image-rendering: -webkit-optimize-contrast;
        image-rendering: crisp-edges;
        image-rendering: pixelated;
    }}
    
    /* Additional enhancement for better text readability */
    .leaflet-tile-pane {{
        /* Slight sharpening effect */
        filter: drop-shadow(0 0 0.5px rgba(0,0,0,0.1));
    }}
    </style>
    """
    return css


def get_enhanced_zoom_for_labels(zoom: int, boost_levels: int = 1) -> int:
    """
    Calculate an enhanced zoom level to request tiles at higher resolution.
    
    Requesting tiles at a slightly higher zoom and scaling them down makes
    labels appear larger relative to the map features. This is especially
    effective for improving label readability.
    
    Args:
        zoom: Requested zoom level (0-20)
        boost_levels: Number of zoom levels to boost (default 1)
                     Higher values = larger labels but more tiles to fetch
    
    Returns:
        Enhanced zoom level (capped at 20)
    """
    # Only boost at lower zoom levels where labels are harder to read
    # At high zoom (15+), labels are already large enough
    if zoom >= 15:
        return zoom  # No boost needed at high zoom
    
    enhanced = min(20, zoom + boost_levels)
    return enhanced


def get_label_enhancement_js(zoom: int) -> str:
    """
    Generate JavaScript to enhance label readability dynamically.
    
    Args:
        zoom: Current zoom level (0-20)
    
    Returns:
        JavaScript string to inject into the page
    """
    js = f"""
    <script>
    (function() {{
        // Enhance ArcGIS tile label readability
        function enhanceArcGISLabels() {{
            const tiles = document.querySelectorAll(
                '.leaflet-tile-container img[src*="arcgis"], ' +
                '.leaflet-tile-container img[src*="static-map-tiles"], ' +
                '.leaflet-tile-container img[src*="ibasemaps-api"]'
            );
            
            tiles.forEach(tile => {{
                // Ensure crisp rendering
                tile.style.imageRendering = 'crisp-edges';
            }});
        }}
        
        // Run immediately and on tile load
        enhanceArcGISLabels();
        
        // Re-run when tiles are added
        const observer = new MutationObserver(enhanceArcGISLabels);
        const mapContainer = document.getElementById('map');
        if (mapContainer) {{
            observer.observe(mapContainer, {{
                childList: true,
                subtree: true
            }});
        }}
        
        // Also run on map zoom/pan events if Leaflet is available
        if (window.L && window.L.Map && window.map) {{
            window.map.on('moveend', enhanceArcGISLabels);
            window.map.on('zoomend', enhanceArcGISLabels);
        }}
    }})();
    </script>
    """
    return js
